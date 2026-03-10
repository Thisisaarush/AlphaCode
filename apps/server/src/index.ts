import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import nodePty from "node-pty";
import { WebSocketServer, WebSocket } from "ws";
import {
  APP_NAME,
  appendMessageSchema,
  createCommandRunSchema,
  createSessionSchema,
  healthResponseSchema,
  saveKeyInputSchema,
  workspaceSnapshotSchema,
  type AuthMethod,
  type CommandRun,
  type FileEntry,
  type ProviderId,
  type SessionDetail,
  type SessionSummary,
  type ToolCall
} from "@alpha-code/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let workspaceRoot = process.env.WORKSPACE_ROOT
  ? path.resolve(process.env.WORKSPACE_ROOT)
  : path.resolve(__dirname, "../../..");
const port = Number(process.env.PORT ?? 3030);

const allowedExtensions = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".css", ".json", ".md", ".html", ".yml", ".yaml"
]);

const ignoredDirectories = new Set([".git", "node_modules", "dist", ".turbo", ".vite"]);
const textEncoder = new TextEncoder();

const promptSuggestions = [
  { id: "fix", label: "Find what is broken in the active file" },
  { id: "plan", label: "Outline the next implementation steps" },
  { id: "run", label: "Run the web and desktop apps locally" }
];

/** Server-side session storage — extends the wire type with workspace tagging */
type StoredSession = SessionDetail & { workspace?: string };

const sessionStore = new Map<string, StoredSession>();
const commandRunStore = new Map<string, CommandRun>();

// Abort controllers for in-flight AI streaming requests (keyed by session id)
const activeAbortControllers = new Map<string, AbortController>();
// Child processes for running terminal commands (keyed by run id)
const activeChildProcesses = new Map<string, ChildProcess>();

/* ================================================================
   SSE Streaming Infrastructure
   ================================================================ */

// Per-session event emitter for streaming tokens to connected SSE clients
// Events: "token" (delta text), "done" (final), "error" (error message)
const sessionEmitters = new Map<string, EventEmitter>();

function getSessionEmitter(sessionId: string): EventEmitter {
  let emitter = sessionEmitters.get(sessionId);
  if (!emitter) {
    emitter = new EventEmitter();
    emitter.setMaxListeners(20);
    sessionEmitters.set(sessionId, emitter);
  }
  return emitter;
}

// Per-run event emitter for streaming terminal output
const terminalEmitters = new Map<string, EventEmitter>();

function getTerminalEmitter(runId: string): EventEmitter {
  let emitter = terminalEmitters.get(runId);
  if (!emitter) {
    emitter = new EventEmitter();
    emitter.setMaxListeners(20);
    terminalEmitters.set(runId, emitter);
  }
  return emitter;
}

/* ================================================================
   Auth Key Store — in-memory storage for API keys
   ================================================================ */

const storedKeys = new Map<string, string>();

/* ----------------------------------------------------------------
   Persistent auth storage — ~/.alpha-code/auth.json
   Stores GitHub OAuth token and manually-entered API keys so they
   survive server restarts.
   ---------------------------------------------------------------- */
const AUTH_DIR = path.join(homedir(), ".alpha-code");
const AUTH_FILE = path.join(AUTH_DIR, "auth.json");

async function loadPersistedAuth(): Promise<void> {
  try {
    const raw = await readFile(AUTH_FILE, "utf8");
    const data = JSON.parse(raw) as Record<string, string>;
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string" && value.length > 0) {
        storedKeys.set(key, value);
      }
    }
    // Migrate old github-oauth key to copilot-oauth
    if (storedKeys.has("github-oauth") && !storedKeys.has("copilot-oauth")) {
      storedKeys.set("copilot-oauth", storedKeys.get("github-oauth")!);
      storedKeys.delete("github-oauth");
      console.log("[auth] Migrated github-oauth → copilot-oauth");
    }
    console.log(`[auth] Loaded ${Object.keys(data).length} persisted key(s) from ${AUTH_FILE}`);
  } catch {
    // File doesn't exist or is invalid — that's fine, first run
    console.log("[auth] No persisted auth found (first run)");
  }
}

/** Persist all stored keys to disk */
async function persistAuth(): Promise<void> {
  try {
    await mkdir(AUTH_DIR, { recursive: true });
    const toSave: Record<string, string> = {};
    for (const [key, value] of storedKeys.entries()) {
      toSave[key] = value;
    }
    await writeFile(AUTH_FILE, JSON.stringify(toSave, null, 2), "utf8");
    console.log(`[auth] Persisted ${Object.keys(toSave).length} key(s) to ${AUTH_FILE}`);
  } catch (err) {
    console.error("[auth] Failed to persist auth:", err instanceof Error ? err.message : err);
  }
}

/* ----------------------------------------------------------------
   Persistent session storage — ~/.alpha-code/sessions.json
   Saves all chat sessions to disk so they survive server restarts.
   Uses debounced writes to avoid thrashing on rapid updates.
   ---------------------------------------------------------------- */
const SESSIONS_FILE = path.join(AUTH_DIR, "sessions.json");

let sessionPersistTimer: ReturnType<typeof setTimeout> | null = null;
const SESSION_PERSIST_DEBOUNCE_MS = 500;

async function loadPersistedSessions(): Promise<void> {
  try {
    const raw = await readFile(SESSIONS_FILE, "utf8");
    const data = JSON.parse(raw) as Record<string, StoredSession>;
    let count = 0;
    for (const [id, session] of Object.entries(data)) {
      if (session && typeof session === "object" && session.id) {
        sessionStore.set(id, session);
        count++;
      }
    }
    console.log(`[sessions] Loaded ${count} persisted session(s) from ${SESSIONS_FILE}`);
  } catch {
    console.log("[sessions] No persisted sessions found (first run)");
  }
}

function persistSessions(): void {
  if (sessionPersistTimer) clearTimeout(sessionPersistTimer);
  sessionPersistTimer = setTimeout(async () => {
    try {
      await mkdir(AUTH_DIR, { recursive: true });
      const toSave: Record<string, StoredSession> = {};
      for (const [id, session] of sessionStore.entries()) {
        toSave[id] = session;
      }
      await writeFile(SESSIONS_FILE, JSON.stringify(toSave, null, 2), "utf8");
      console.log(`[sessions] Persisted ${Object.keys(toSave).length} session(s) to ${SESSIONS_FILE}`);
    } catch (err) {
      console.error("[sessions] Failed to persist sessions:", err instanceof Error ? err.message : err);
    }
  }, SESSION_PERSIST_DEBOUNCE_MS);
}

/* ----------------------------------------------------------------
   Persistent project/workspace list — ~/.alpha-code/projects.json
   Tracks recently-opened project folders so the user can switch
   between them quickly.
   ---------------------------------------------------------------- */
const PROJECTS_FILE = path.join(AUTH_DIR, "projects.json");

interface RecentProject {
  path: string;
  name: string;
  lastOpened: number; // epoch ms
}

let recentProjects: RecentProject[] = [];

async function loadPersistedProjects(): Promise<void> {
  try {
    const raw = await readFile(PROJECTS_FILE, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      recentProjects = data;
      console.log(`[projects] Loaded ${recentProjects.length} recent project(s) from ${PROJECTS_FILE}`);
    }
  } catch {
    console.log("[projects] No persisted projects found (first run)");
  }
}

async function persistProjects(): Promise<void> {
  try {
    await mkdir(AUTH_DIR, { recursive: true });
    await writeFile(PROJECTS_FILE, JSON.stringify(recentProjects, null, 2), "utf8");
  } catch (err) {
    console.error("[projects] Failed to persist projects:", err instanceof Error ? err.message : err);
  }
}

function touchProject(projectPath: string): void {
  const name = path.basename(projectPath);
  const existing = recentProjects.findIndex((p) => p.path === projectPath);
  if (existing !== -1) {
    recentProjects[existing].lastOpened = Date.now();
  } else {
    recentProjects.push({ path: projectPath, name, lastOpened: Date.now() });
  }
  // Keep max 20, sorted by most recent
  recentProjects.sort((a, b) => b.lastOpened - a.lastOpened);
  recentProjects = recentProjects.slice(0, 20);
  void persistProjects();
}

// GitHub OAuth Device Flow state
interface GitHubDeviceFlowState {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}

let githubDeviceFlow: GitHubDeviceFlowState | null = null;

// GitHub Copilot OAuth App client_id — the shared Copilot client
const COPILOT_CLIENT_ID = process.env.COPILOT_CLIENT_ID ?? "Ov23li8tweQw6odWQebz";

function getKeyForProvider(providerId: string): string | undefined {
  if (providerId === "copilot") {
    // Copilot: OAuth token is the primary auth method
    const oauthToken = storedKeys.get("copilot-oauth");
    if (oauthToken) return oauthToken;
    // Allow env var fallback
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    return undefined;
  }

  // Other providers: stored key > env var
  const stored = storedKeys.get(providerId);
  if (stored) return stored;

  const config = providerConfigs.find((c) => c.id === providerId);
  if (!config) return undefined;

  return process.env[config.envKey];
}

/**
 * Async version of getKeyForProvider — currently just delegates to sync version.
 * Kept async in case we add token refresh flows in the future.
 */
async function getKeyForProviderAsync(providerId: string): Promise<string | undefined> {
  return getKeyForProvider(providerId);
}

function getAuthMethod(config: ProviderConfig): AuthMethod {
  if (config.id === "copilot") {
    if (storedKeys.has("copilot-oauth")) return "oauth";
    if (process.env.GITHUB_TOKEN) return "env";
    return "none";
  }
  if (storedKeys.has(config.id)) return "stored_key";
  if (process.env[config.envKey]) return "env";
  return "none";
}

async function startGitHubDeviceFlow(): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}> {
  console.log(`[auth] Starting GitHub Copilot device flow with client_id: ${COPILOT_CLIENT_ID}`);

  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      scope: "read:user"
    })
  });

  const responseText = await response.text();
  console.log(`[auth] GitHub device/code response (${response.status}): ${responseText.slice(0, 500)}`);

  if (!response.ok) {
    throw new Error(`GitHub device code request failed: HTTP ${response.status} ${responseText.slice(0, 300)}`);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(responseText) as Record<string, unknown>;
  } catch {
    throw new Error(`GitHub returned non-JSON response: ${responseText.slice(0, 200)}`);
  }

  // GitHub sometimes returns 200 with an error field
  if (data.error) {
    throw new Error(`GitHub error: ${String(data.error_description ?? data.error)}`);
  }

  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error(`GitHub response missing required fields: ${responseText.slice(0, 200)}`);
  }

  githubDeviceFlow = {
    deviceCode: String(data.device_code),
    userCode: String(data.user_code),
    verificationUri: String(data.verification_uri),
    expiresAt: Date.now() + (Number(data.expires_in) || 900) * 1000,
    interval: Number(data.interval) || 5
  };

  console.log(`[auth] Device flow started. User code: ${githubDeviceFlow.userCode}, URI: ${githubDeviceFlow.verificationUri}`);

  return {
    deviceCode: githubDeviceFlow.deviceCode,
    userCode: githubDeviceFlow.userCode,
    verificationUri: githubDeviceFlow.verificationUri,
    expiresIn: Number(data.expires_in) || 900,
    interval: Number(data.interval) || 5
  };
}

async function pollGitHubDeviceFlow(deviceCode: string): Promise<{
  status: "pending" | "completed" | "expired" | "error";
  token?: string;
  error?: string;
  interval?: number;
}> {
  if (githubDeviceFlow && Date.now() > githubDeviceFlow.expiresAt) {
    console.log("[auth] Device code expired");
    githubDeviceFlow = null;
    return { status: "expired", error: "Device code expired. Please start a new login." };
  }

  try {
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      })
    });

    const responseText = await response.text();
    console.log(`[auth] GitHub poll response (${response.status}): ${responseText.slice(0, 300)}`);

    if (!response.ok) {
      return { status: "error", error: `HTTP ${response.status}: ${responseText.slice(0, 200)}` };
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(responseText) as Record<string, unknown>;
    } catch {
      return { status: "error", error: `Non-JSON response: ${responseText.slice(0, 200)}` };
    }

    if (data.access_token) {
      const oauthToken = String(data.access_token);
      // Store as copilot-oauth — this token works with api.githubcopilot.com
      storedKeys.set("copilot-oauth", oauthToken);
      invalidateModelCache("copilot");
      githubDeviceFlow = null;
      console.log("[auth] GitHub Copilot OAuth completed — token stored as copilot-oauth");

      // Persist the OAuth token to disk for restart survival
      void persistAuth();

      return { status: "completed", token: oauthToken };
    }

    const errorCode = String(data.error ?? "");

    if (errorCode === "authorization_pending") {
      return { status: "pending" };
    }

    if (errorCode === "slow_down") {
      // GitHub tells us to increase our interval — pass it back to client
      const newInterval = Number(data.interval) || 10;
      console.log(`[auth] GitHub slow_down — new interval: ${newInterval}s`);
      return { status: "pending", interval: newInterval };
    }

    if (errorCode === "expired_token") {
      githubDeviceFlow = null;
      return { status: "expired", error: "Device code expired." };
    }

    if (errorCode === "incorrect_client_credentials") {
      githubDeviceFlow = null;
      return { status: "error", error: "Invalid GitHub OAuth App client_id. Set COPILOT_CLIENT_ID env var with your own GitHub OAuth App client ID." };
    }

    if (errorCode === "incorrect_device_code") {
      githubDeviceFlow = null;
      return { status: "error", error: "Invalid device code. Please start a new login." };
    }

    // Any other error
    const errorDesc = String(data.error_description ?? data.error ?? "Unknown error");
    console.log(`[auth] GitHub poll error: ${errorDesc}`);
    return { status: "error", error: errorDesc };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Poll failed";
    console.error(`[auth] GitHub poll exception: ${msg}`);
    return { status: "error", error: msg };
  }
}

/* ================================================================
   AI Provider Configuration
   ================================================================ */

interface ProviderConfig {
  id: string;
  label: string;
  envKey: string;
  baseUrl: string;
  defaultModel: string;
  /** Fallback static model IDs when dynamic fetch fails */
  fallbackModels: string[];
  format: "openai" | "anthropic" | "copilot";
}

const providerConfigs: ProviderConfig[] = [
  {
    id: "copilot",
    label: "Copilot",
    envKey: "GITHUB_TOKEN",
    baseUrl: "https://api.githubcopilot.com",
    defaultModel: "claude-sonnet-4.6",
    fallbackModels: [
      "claude-sonnet-4.6", "claude-sonnet-4.5", "claude-opus-4.6", "claude-opus-4.5", "claude-haiku-4.5",
      "gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5", "gpt-5-mini",
      "gpt-4.1", "gpt-4o", "o4-mini", "o3-mini",
      "gemini-3-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro",
      "grok-code-fast-1"
    ],
    format: "copilot"
  },
  {
    id: "openai",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    fallbackModels: [
      "gpt-4o", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
      "gpt-4o-mini", "o4-mini", "o3-mini"
    ],
    format: "openai"
  },
  {
    id: "anthropic",
    label: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-20250514",
    fallbackModels: [
      "claude-sonnet-4-20250514", "claude-opus-4-20250514",
      "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"
    ],
    format: "anthropic"
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o",
    fallbackModels: [
      "openai/gpt-4o", "openai/gpt-4.1", "anthropic/claude-sonnet-4-20250514",
      "anthropic/claude-opus-4-20250514", "google/gemini-2.5-pro-preview",
      "google/gemini-2.5-flash-preview", "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner", "meta-llama/llama-4-maverick"
    ],
    format: "openai"
  }
];

function getProviderStatus(config: ProviderConfig): "connected" | "disconnected" | "experimental" {
  if (config.id === "copilot") {
    const hasOAuth = storedKeys.has("copilot-oauth");
    const hasEnv = !!process.env[config.envKey];
    if (hasOAuth || hasEnv) return "connected";
    return "disconnected";
  }

  const key = getKeyForProvider(config.id);
  if (!key) return "disconnected";
  return "connected";
}

/* ================================================================
   Provider Usage / Quota Tracking
   ================================================================ */

/** Provider usage info returned to clients */
interface ProviderUsageInfo {
  providerId: string;
  /** Usage as a percentage (0-100). null if unknown. */
  usagePercent: number | null;
  /** Human-readable usage label, e.g. "42 / 300 premium requests" */
  usageLabel: string;
  /** Detailed breakdown for hover tooltip */
  details: string;
  /** Whether this provider has real quota data (vs local tracking only) */
  hasQuota: boolean;
}

/** Cached Copilot rate limit data from API response headers */
let copilotRateLimitCache: {
  limit?: number;       // x-ratelimit-limit (monthly premium request limit)
  remaining?: number;   // x-ratelimit-remaining
  used?: number;        // x-ratelimit-used
  reset?: string;       // x-ratelimit-reset timestamp
  updatedAt: number;
} = { updatedAt: 0 };

/** Cumulative token usage tracked locally per provider (for providers without usage APIs) */
const localUsageTracker = new Map<string, { inputTokens: number; outputTokens: number; requestCount: number }>();

function trackLocalUsage(providerId: string, usage?: UsageData) {
  const existing = localUsageTracker.get(providerId) ?? { inputTokens: 0, outputTokens: 0, requestCount: 0 };
  existing.requestCount += 1;
  if (usage) {
    existing.inputTokens += usage.inputTokens;
    existing.outputTokens += usage.outputTokens;
  }
  localUsageTracker.set(providerId, existing);
}

/** Capture rate limit headers from a Copilot API response */
function captureCopilotRateLimits(headers: Headers) {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const used = headers.get("x-ratelimit-used");
  const reset = headers.get("x-ratelimit-reset");
  if (limit || remaining || used) {
    copilotRateLimitCache = {
      limit: limit ? parseInt(limit, 10) : copilotRateLimitCache.limit,
      remaining: remaining ? parseInt(remaining, 10) : copilotRateLimitCache.remaining,
      used: used ? parseInt(used, 10) : copilotRateLimitCache.used,
      reset: reset ?? copilotRateLimitCache.reset,
      updatedAt: Date.now(),
    };
    console.log(`[copilot-ratelimit] limit=${copilotRateLimitCache.limit} used=${copilotRateLimitCache.used} remaining=${copilotRateLimitCache.remaining}`);
  }
}

/** Fetch OpenRouter key usage data */
async function fetchOpenRouterUsage(): Promise<ProviderUsageInfo> {
  const apiKey = await getKeyForProviderAsync("openrouter");
  if (!apiKey) {
    return { providerId: "openrouter", usagePercent: null, usageLabel: "No API key", details: "Set an API key in Settings", hasQuota: false };
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as {
      data: {
        label: string;
        limit: number | null;
        limit_remaining: number | null;
        usage: number;
        usage_monthly: number;
        is_free_tier: boolean;
      };
    };
    const d = data.data;
    const hasLimit = d.limit !== null && d.limit > 0;
    const usagePercent = hasLimit ? Math.min(((d.usage / d.limit!) * 100), 100) : null;
    const usageLabel = hasLimit
      ? `$${d.usage.toFixed(2)} / $${d.limit!.toFixed(2)}`
      : `$${d.usage.toFixed(2)} used`;
    const details = [
      `Total: $${d.usage.toFixed(4)}`,
      `Monthly: $${d.usage_monthly.toFixed(4)}`,
      hasLimit ? `Limit: $${d.limit!.toFixed(2)}` : "No limit set",
      hasLimit ? `Remaining: $${d.limit_remaining!.toFixed(2)}` : "",
      d.is_free_tier ? "Free tier" : "Paid account",
    ].filter(Boolean).join("\n");

    return { providerId: "openrouter", usagePercent, usageLabel, details, hasQuota: hasLimit };
  } catch (err) {
    console.error("[provider-usage] OpenRouter fetch failed:", err);
    return { providerId: "openrouter", usagePercent: null, usageLabel: "Error fetching", details: "Failed to fetch usage", hasQuota: false };
  }
}

/** Get Copilot usage from cached rate limit headers */
function getCopilotUsage(): ProviderUsageInfo {
  const local = localUsageTracker.get("copilot");
  const rl = copilotRateLimitCache;

  if (rl.limit && rl.limit > 0 && rl.used !== undefined) {
    const usagePercent = Math.min((rl.used / rl.limit) * 100, 100);
    const usageLabel = `${rl.used} / ${rl.limit} premium requests`;
    const details = [
      `Premium requests used: ${rl.used}`,
      `Limit: ${rl.limit}`,
      `Remaining: ${rl.remaining ?? "?"}`,
      rl.reset ? `Resets: ${new Date(parseInt(rl.reset, 10) * 1000).toLocaleDateString()}` : "",
      local ? `Session: ${local.requestCount} requests, ${(local.inputTokens + local.outputTokens).toLocaleString()} tokens` : "",
    ].filter(Boolean).join("\n");

    return { providerId: "copilot", usagePercent, usageLabel, details, hasQuota: true };
  }

  // No rate limit data yet — fall back to local tracking
  if (local) {
    return {
      providerId: "copilot",
      usagePercent: null,
      usageLabel: `${local.requestCount} requests`,
      details: `Requests: ${local.requestCount}\nTokens: ${(local.inputTokens + local.outputTokens).toLocaleString()}\n(Premium quota data available after first API call)`,
      hasQuota: false,
    };
  }

  return { providerId: "copilot", usagePercent: null, usageLabel: "No usage yet", details: "Make a request to see usage", hasQuota: false };
}

/** Get local-only usage for OpenAI / Anthropic (no public usage API) */
function getLocalUsage(providerId: string): ProviderUsageInfo {
  const local = localUsageTracker.get(providerId);
  if (local) {
    const totalTokens = local.inputTokens + local.outputTokens;
    return {
      providerId,
      usagePercent: null,
      usageLabel: `${local.requestCount} requests`,
      details: `Requests: ${local.requestCount}\nInput tokens: ${local.inputTokens.toLocaleString()}\nOutput tokens: ${local.outputTokens.toLocaleString()}\nTotal tokens: ${totalTokens.toLocaleString()}`,
      hasQuota: false,
    };
  }
  return { providerId, usagePercent: null, usageLabel: "No usage yet", details: "Make a request to see usage", hasQuota: false };
}

/** Fetch usage for all providers */
async function getAllProviderUsage(): Promise<ProviderUsageInfo[]> {
  const results: ProviderUsageInfo[] = [];

  // Copilot — from rate limit headers cache
  results.push(getCopilotUsage());

  // OpenRouter — live API call
  const orKey = await getKeyForProviderAsync("openrouter");
  if (orKey) {
    results.push(await fetchOpenRouterUsage());
  } else {
    results.push({ providerId: "openrouter", usagePercent: null, usageLabel: "No API key", details: "Set an API key in Settings", hasQuota: false });
  }

  // OpenAI — local tracking only
  results.push(getLocalUsage("openai"));

  // Anthropic — local tracking only
  results.push(getLocalUsage("anthropic"));

  return results;
}

/* ================================================================
   Dynamic Model Fetching — queries each provider's API for available models
   ================================================================ */

interface ModelCache {
  models: string[];
  fetchedAt: number;
}

const modelCache = new Map<string, ModelCache>();
const MODEL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** OpenAI chat model prefixes — filter out embedding, TTS, whisper, DALL-E etc. */
const OPENAI_CHAT_PREFIXES = ["gpt-", "o1", "o3", "o4", "chatgpt-"];
const OPENAI_EXCLUDE_PATTERNS = ["realtime", "audio", "search", "transcribe"];

/** Copilot chat-compatible model prefixes — only models matching these are shown */
const COPILOT_CHAT_PREFIXES = [
  "gpt-", "claude-", "o1", "o3", "o4",
  "gemini-", "chatgpt-", "grok-",
];
const COPILOT_EXCLUDE_PATTERNS = [
  "embed", "whisper", "tts", "dall-e", "davinci", "babbage",
  "moderation", "text-embedding", "code-search", "text-search",
  "text-similarity", "curie", "ada", "realtime", "audio", "transcribe"
];

/** Check if a Copilot model is chat-compatible */
function isCopilotChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (COPILOT_EXCLUDE_PATTERNS.some((p) => lower.includes(p))) return false;
  return COPILOT_CHAT_PREFIXES.some((p) => lower.startsWith(p));
}

/** GPT-5+ models (except gpt-5-mini) need the Responses API (/responses) instead of /chat/completions */
function shouldUseCopilotResponsesApi(model: string): boolean {
  const lower = model.toLowerCase();
  // gpt-5, gpt-5.2-codex, gpt-5.3-codex, gpt-5.4, etc. → Responses API
  // gpt-5-mini → Chat Completions API (not Responses)
  if (lower.startsWith("gpt-5") && !lower.startsWith("gpt-5-mini")) return true;
  return false;
}

/** Check if a model is a reasoning model (no temperature, uses developer role) */
function isCopilotReasoningModel(model: string): boolean {
  const lower = model.toLowerCase();
  // o1, o3, o4 series are reasoning models
  if (lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) return true;
  // gpt-5 main models are reasoning (but gpt-5-mini and gpt-5-chat are not)
  if (lower.startsWith("gpt-5") && !lower.startsWith("gpt-5-mini") && !lower.startsWith("gpt-5-chat")) return true;
  return false;
}

/** Strip date suffixes from model IDs for deduplication.
 *  e.g. "gpt-4o-2024-08-06" → "gpt-4o", "gpt-4.1-2025-04-14" → "gpt-4.1"
 */
function stripDateSuffix(id: string): string {
  return id.replace(/-\d{4}-?\d{2}-?\d{2}$/, "").replace(/-\d{8}$/, "");
}

/** Deduplicate models: for models with the same base ID (after stripping date suffixes),
 *  keep only the base (non-dated) version. If all versions have dates, keep the latest (last sorted). */
function deduplicateModels(models: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const m of models) {
    const key = stripDateSuffix(m);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  const result: string[] = [];
  for (const [key, variants] of groups) {
    // Prefer the base (non-dated) version
    const base = variants.find((v) => v === key);
    if (base) {
      result.push(base);
    } else {
      // All have dates — pick the latest (sorted descending, take first)
      variants.sort().reverse();
      result.push(variants[0]);
    }
  }
  return result.sort();
}

async function fetchModelsForProvider(config: ProviderConfig): Promise<string[]> {
  const apiKey = await getKeyForProviderAsync(config.id);
  if (!apiKey) return config.fallbackModels;

  // Check cache
  const cached = modelCache.get(config.id);
  if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL) {
    return cached.models;
  }

  try {
    let models: string[] = [];

    if (config.format === "copilot") {
      const res = await fetch(`${config.baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Openai-Intent": "conversation-edits",
          "User-Agent": "AlphaCode/1.0",
          "x-initiator": "user"
        }
      });
      if (!res.ok) throw new Error(`Copilot /models returned ${res.status}`);
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      models = (data.data ?? [])
        .map((m) => m.id)
        .filter(isCopilotChatModel)
        .sort();
    } else if (config.format === "openai" && config.id === "openai") {
      const res = await fetch(`${config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error(`OpenAI /models returned ${res.status}`);
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      models = (data.data ?? [])
        .map((m) => m.id)
        .filter((id) => OPENAI_CHAT_PREFIXES.some((p) => id.startsWith(p)))
        .filter((id) => !OPENAI_EXCLUDE_PATTERNS.some((p) => id.includes(p)))
        .sort();
    } else if (config.format === "anthropic") {
      const res = await fetch(`${config.baseUrl}/models?limit=1000`, {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        }
      });
      if (!res.ok) throw new Error(`Anthropic /models returned ${res.status}`);
      const data = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
      models = (data.data ?? []).map((m) => m.id);
    } else if (config.id === "openrouter") {
      const res = await fetch(`${config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
      const data = (await res.json()) as { data?: Array<{ id: string; name?: string }> };
      // OpenRouter returns hundreds of models — take top popular ones
      models = (data.data ?? [])
        .map((m) => m.id)
        .filter((id) => {
          // Include major providers' models
          const prefixes = ["openai/", "anthropic/", "google/", "deepseek/", "meta-llama/", "mistralai/", "cohere/"];
          return prefixes.some((p) => id.startsWith(p));
        })
        .slice(0, 50); // Cap at 50 to keep the dropdown manageable
    }

    if (models.length > 0) {
      models = deduplicateModels(models);
      modelCache.set(config.id, { models, fetchedAt: Date.now() });
      console.log(`[models] Fetched ${models.length} models for ${config.label}`);
      return models;
    }
  } catch (err) {
    console.warn(`[models] Failed to fetch models for ${config.label}:`, err instanceof Error ? err.message : err);
  }

  // Fall back to static list
  return config.fallbackModels;
}

/** Get models for a provider — returns cached dynamic list or fallback */
async function getModelsForProvider(config: ProviderConfig): Promise<string[]> {
  return fetchModelsForProvider(config);
}

/** Invalidate model cache for a provider (e.g., after auth change) */
function invalidateModelCache(providerId?: string): void {
  if (providerId) {
    modelCache.delete(providerId);
  } else {
    modelCache.clear();
  }
}

function resolveProvider(providerLabel: string): ProviderConfig | null {
  return providerConfigs.find((c) => c.label === providerLabel) ?? null;
}

function resolveModel(config: ProviderConfig, uiModel: string): string {
  // Model IDs are now passed directly from the UI — no translation needed
  return uiModel || config.defaultModel;
}

function getSystemPrompt(): string {
  return `You are Alpha Code, an AI coding assistant running inside a local-first code editor. You help users with software engineering tasks: inspecting code, planning implementations, writing code, running commands, and reviewing changes.

Be concise and direct. Use markdown for code blocks.

You have access to the following tools and MUST use them when the user asks you to perform actions:
- run_command: Execute shell commands in the project directory (builds, tests, git, npm, node, etc.)
- read_file: Read file contents from the workspace
- write_file: Create or overwrite files in the workspace
- list_files: List directory contents

ALWAYS use the run_command tool when the user asks you to run something, check versions, execute tests, install packages, etc. Do NOT just suggest commands — actually run them using the tool. Similarly, use read_file to inspect code rather than asking the user to provide it.

The user is working in a project at: ${workspaceRoot}
Project name: ${path.basename(workspaceRoot)}`;
}

/** Build a compact file tree string for AI context (max ~200 entries) */
async function getWorkspaceFileTree(): Promise<string> {
  try {
    const files = await collectFiles(workspaceRoot);
    const paths = files.map((f) => f.path).slice(0, 200);
    if (paths.length === 0) return "";
    return `\nWorkspace file tree (${paths.length} files):\n${paths.join("\n")}`;
  } catch {
    return "";
  }
}

/* ================================================================
   Tool Definitions — available to AI via function calling
   ================================================================ */

/** OpenAI / Copilot Chat Completions tool format */
const AI_TOOLS_OPENAI = [
  {
    type: "function" as const,
    function: {
      name: "run_command",
      description: "Execute a shell command in the user's project directory. Use this to run builds, tests, linters, git commands, or any CLI tool. The command runs in the workspace root directory.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute (e.g., 'node -v', 'npm test', 'ls -la')" }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read the contents of a file in the workspace. Use this to inspect source code, config files, etc. The path should be relative to the workspace root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path from workspace root (e.g., 'src/index.ts', 'package.json')" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description: "List files and directories in a given directory within the workspace. Returns entries with type indicators (dir/ or file).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative directory path from workspace root (e.g., 'src', '.'). Defaults to workspace root." }
        },
        required: []
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write or overwrite a file in the workspace. Use this to create new files or edit existing ones. Provide the full file content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path from workspace root (e.g., 'src/utils.ts')" },
          content: { type: "string", description: "The complete file content to write" }
        },
        required: ["path", "content"]
      }
    }
  }
];

/** Anthropic tool format */
const AI_TOOLS_ANTHROPIC = AI_TOOLS_OPENAI.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters
}));

/** Copilot Responses API tool format (same as OpenAI but flat) */
const AI_TOOLS_RESPONSES = AI_TOOLS_OPENAI.map((t) => ({
  type: "function" as const,
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters
}));

/** Execute a tool call and return the result string */
async function executeTool(name: string, argsJson: string): Promise<{ result: string; isError: boolean }> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return { result: `Error: Invalid JSON arguments: ${argsJson}`, isError: true };
  }

  switch (name) {
    case "run_command": {
      const command = String(args.command ?? "");
      if (!command) return { result: "Error: No command provided", isError: true };
      console.log(`[tool] run_command: ${command}`);
      try {
        const output = execSync(command, {
          cwd: workspaceRoot,
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            PATH: `/Users/aarushtanwar/.nvm/versions/node/v20.20.0/bin:${process.env.PATH ?? ""}`
          }
        });
        return { result: output || "(no output)", isError: false };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
        const out = (e.stdout ?? "") + (e.stderr ?? "");
        return { result: out || e.message || "Command failed", isError: true };
      }
    }
    case "read_file": {
      const filePath = String(args.path ?? "");
      if (!filePath) return { result: "Error: No path provided", isError: true };
      const absPath = path.resolve(workspaceRoot, filePath);
      if (!absPath.startsWith(workspaceRoot)) return { result: "Error: Path outside workspace", isError: true };
      console.log(`[tool] read_file: ${filePath}`);
      try {
        const content = await readFile(absPath, "utf8");
        // Truncate very large files
        if (content.length > 100_000) {
          return { result: content.slice(0, 100_000) + "\n\n... [truncated, file is " + content.length + " chars]", isError: false };
        }
        return { result: content, isError: false };
      } catch (err) {
        return { result: `Error reading file: ${(err as Error).message}`, isError: true };
      }
    }
    case "list_files": {
      const dirPath = String(args.path ?? ".");
      const absDir = path.resolve(workspaceRoot, dirPath);
      if (!absDir.startsWith(workspaceRoot)) return { result: "Error: Path outside workspace", isError: true };
      console.log(`[tool] list_files: ${dirPath}`);
      try {
        const entries = await readdir(absDir, { withFileTypes: true });
        const lines = entries
          .filter((e) => !ignoredDirectories.has(e.name))
          .map((e) => e.isDirectory() ? `${e.name}/` : e.name);
        return { result: lines.join("\n") || "(empty directory)", isError: false };
      } catch (err) {
        return { result: `Error listing directory: ${(err as Error).message}`, isError: true };
      }
    }
    case "write_file": {
      const filePath = String(args.path ?? "");
      const content = String(args.content ?? "");
      if (!filePath) return { result: "Error: No path provided", isError: true };
      const absPath = path.resolve(workspaceRoot, filePath);
      if (!absPath.startsWith(workspaceRoot)) return { result: "Error: Path outside workspace", isError: true };
      console.log(`[tool] write_file: ${filePath}`);
      try {
        // Ensure parent directory exists
        await mkdir(path.dirname(absPath), { recursive: true });
        await writeFile(absPath, content, "utf8");
        return { result: `File written: ${filePath} (${content.length} chars)`, isError: false };
      } catch (err) {
        return { result: `Error writing file: ${(err as Error).message}`, isError: true };
      }
    }
    default:
      return { result: `Error: Unknown tool: ${name}`, isError: true };
  }
}

/* ================================================================
   AI Completion — calls the selected provider
   ================================================================ */

interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  // Present on assistant messages that invoke tools
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  // Present on tool result messages (role === "tool")
  tool_call_id?: string;
  name?: string;                   // tool name for tool-result messages
}

async function callAI(
  providerLabel: string,
  uiModel: string,
  messages: ChatMessage[],
  fileContext?: string
): Promise<string> {
  const config = resolveProvider(providerLabel);
  if (!config) {
    return `[Error] Unknown provider: ${providerLabel}. Available: ${providerConfigs.map((c) => c.label).join(", ")}`;
  }

  const apiKey = await getKeyForProviderAsync(config.id);
  if (!apiKey) {
    return `[Error] No API key set for ${config.label}. Go to Settings in the sidebar to add your API key, or set the ${config.envKey} environment variable and restart the server.\n\nExample:\n\`\`\`bash\nexport ${config.envKey}="your-key-here"\n\`\`\``;
  }

  const model = resolveModel(config, uiModel);

  // Build messages with system prompt, workspace file tree, and optional file context
  const basePrompt = getSystemPrompt();
  const fileTree = await getWorkspaceFileTree();
  let systemContent = basePrompt + fileTree;
  if (fileContext) {
    systemContent += `\n\nThe user currently has this file open:\n\`\`\`\n${fileContext}\n\`\`\``;
  }

  const chatMessages: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...messages
  ];

  try {
    if (config.format === "anthropic") {
      return await callAnthropic(config, apiKey, model, chatMessages);
    }
    if (config.format === "copilot") {
      return await callCopilot(config, apiKey, model, chatMessages);
    }
    return await callOpenAICompatible(config, apiKey, model, chatMessages);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ai] ${config.label} error:`, message);

    return `[Error] ${config.label} API call failed: ${message}`;
  }
}

async function callOpenAICompatible(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[]
): Promise<string> {
  const url = `${config.baseUrl}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };

  // OpenRouter wants extra headers
  if (config.id === "openrouter") {
    headers["HTTP-Referer"] = "https://alpha-code.local";
    headers["X-Title"] = "Alpha Code";
  }

  const body = JSON.stringify({
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: 16384,
    temperature: 0.3
  });

  console.log(`[ai] Calling ${config.label} (${model}) at ${url}`);
  const response = await fetch(url, { method: "POST", headers, body });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(data.error.message ?? "Unknown API error");
  }

  return data.choices?.[0]?.message?.content ?? "[No response from model]";
}

async function callCopilot(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[]
): Promise<string> {
  const url = `${config.baseUrl}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "Openai-Intent": "conversation-edits",
    "User-Agent": "AlphaCode/1.0",
    "Editor-Version": "AlphaCode/1.0"
  };

  const body = JSON.stringify({
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: 16384,
    temperature: 0.3
  });

  console.log(`[ai] Calling ${config.label} (${model}) at ${url}`);
  const response = await fetch(url, { method: "POST", headers, body });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(data.error.message ?? "Unknown API error");
  }

  return data.choices?.[0]?.message?.content ?? "[No response from model]";
}

async function callAnthropic(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[]
): Promise<string> {
  const url = `${config.baseUrl}/messages`;

  // Anthropic: system goes in a separate field, not in messages array
  const systemMessage = messages.find((m) => m.role === "system");
  const chatMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // Anthropic requires alternating user/assistant — ensure first message is user
  if (chatMessages.length > 0 && chatMessages[0].role !== "user") {
    chatMessages.unshift({ role: "user", content: "(start)" });
  }

  const body = JSON.stringify({
    model,
    max_tokens: 16384,
    system: systemMessage?.content ?? getSystemPrompt(),
    messages: chatMessages
  });

  console.log(`[ai] Calling ${config.label} (${model}) at ${url}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(data.error.message ?? "Unknown API error");
  }

  return data.content?.map((block) => block.text ?? "").join("") ?? "[No response from model]";
}

/* ================================================================
   Streaming AI Calls
   ================================================================ */

type TokenCallback = (token: string) => void;

/** Usage data from API responses */
interface UsageData {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Result from streaming AI calls, includes content, optional tool calls, and optional usage */
interface StreamResult {
  content: string;
  usage?: UsageData;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

/** Parse SSE lines from a readable stream, calling onToken for each content delta.
 *  Also accumulates tool_calls from OpenAI-format deltas. */
async function parseSSEStream(
  body: ReadableStream<Uint8Array>,
  extractDelta: (parsed: Record<string, unknown>) => string | null,
  onToken: TokenCallback,
  signal?: AbortSignal,
  extractUsage?: (parsed: Record<string, unknown>) => UsageData | null,
  extractToolCallDelta?: (parsed: Record<string, unknown>) => { index: number; id?: string; name?: string; arguments?: string } | null
): Promise<StreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let usage: UsageData | undefined;
  // Accumulate tool calls by index
  const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel();
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6);
      if (payload === "[DONE]") continue;

      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        const delta = extractDelta(parsed);
        if (delta) {
          fullContent += delta;
          onToken(delta);
        }
        // Accumulate tool call deltas
        if (extractToolCallDelta) {
          const tc = extractToolCallDelta(parsed);
          if (tc) {
            const existing = toolCallAccum.get(tc.index);
            if (existing) {
              if (tc.arguments) existing.arguments += tc.arguments;
            } else {
              toolCallAccum.set(tc.index, {
                id: tc.id ?? `tool_${tc.index}`,
                name: tc.name ?? "",
                arguments: tc.arguments ?? ""
              });
            }
          }
        }
        // Try to extract usage data (typically in the final chunk)
        if (extractUsage) {
          const u = extractUsage(parsed);
          if (u) usage = u;
        }
      } catch {
        // skip malformed SSE lines
      }
    }
  }
  } catch (err) {
    // If aborted, return what we have so far
    if (signal?.aborted) {
      const toolCalls = toolCallAccum.size > 0 ? Array.from(toolCallAccum.values()) : undefined;
      return { content: fullContent || "[Streaming aborted]", usage, toolCalls };
    }
    throw err;
  }

  const toolCalls = toolCallAccum.size > 0 ? Array.from(toolCallAccum.values()) : undefined;
  return { content: fullContent || (toolCalls ? "" : "[No response from model]"), usage, toolCalls };
}

async function callOpenAICompatibleStream(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: TokenCallback,
  signal?: AbortSignal
): Promise<StreamResult> {
  const url = `${config.baseUrl}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };

  if (config.id === "openrouter") {
    headers["HTTP-Referer"] = "https://alpha-code.local";
    headers["X-Title"] = "Alpha Code";
  }

  const body = JSON.stringify({
    model,
    messages: messages.map((m) => {
      const msg: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.tool_call_id) { msg.tool_call_id = m.tool_call_id; msg.name = m.name; }
      return msg;
    }),
    max_tokens: 16384,
    temperature: 0.3,
    stream: true,
    stream_options: { include_usage: true },
    tools: AI_TOOLS_OPENAI,
    tool_choice: "auto"
  });

  console.log(`[ai-stream] Calling ${config.label} (${model}) at ${url}`);
  const response = await fetch(url, { method: "POST", headers, body, signal });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`);
  }

  if (!response.body) {
    throw new Error("No response body for streaming");
  }

  return parseSSEStream(
    response.body,
    (parsed) => {
      const choices = parsed.choices as Array<{ delta?: { content?: string } }> | undefined;
      return choices?.[0]?.delta?.content ?? null;
    },
    onToken,
    signal,
    // Extract usage from the final chunk (Chat Completions includes usage when stream_options.include_usage is true)
    (parsed) => {
      const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
      if (usage && typeof usage.prompt_tokens === "number") {
        return {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? (usage.prompt_tokens + (usage.completion_tokens ?? 0))
        };
      }
      return null;
    },
    // Extract tool call deltas from OpenAI streaming format
    (parsed) => {
      const choices = parsed.choices as Array<{
        delta?: { tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
      }> | undefined;
      const tc = choices?.[0]?.delta?.tool_calls?.[0];
      if (!tc) return null;
      return { index: tc.index, id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments };
    }
  );
}

async function callCopilotStream(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: TokenCallback,
  signal?: AbortSignal
): Promise<StreamResult> {
  const useResponsesApi = shouldUseCopilotResponsesApi(model);
  const isReasoning = isCopilotReasoningModel(model);

  const copilotHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "Openai-Intent": "conversation-edits",
    "User-Agent": "AlphaCode/1.0",
    "x-initiator": "user"
  };

  if (useResponsesApi) {
    // --- Responses API for GPT-5+ models ---
    const url = `${config.baseUrl}/responses`;

    // Convert messages to Responses API input format
    const input: Array<Record<string, unknown>> = [];
    for (const m of messages) {
      if (m.role === "system") {
        input.push({ role: isReasoning ? "developer" : "system", content: m.content });
      } else if (m.role === "user") {
        input.push({ role: "user", content: [{ type: "input_text", text: m.content }] });
      } else if (m.role === "assistant") {
        if (m.tool_calls && m.tool_calls.length > 0) {
          // Assistant message with tool calls — emit function_call items
          if (m.content) {
            input.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
          }
          for (const tc of m.tool_calls) {
            input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
          }
        } else {
          input.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
        }
      } else if (m.role === "tool") {
        // Tool result — Responses API uses function_call_output
        input.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content });
      }
    }

    const bodyObj: Record<string, unknown> = {
      model,
      input,
      stream: true,
      max_output_tokens: 16384,
      tools: AI_TOOLS_RESPONSES,
    };

    // Reasoning models: no temperature, add reasoning config
    if (isReasoning) {
      bodyObj.reasoning = { effort: "medium", summary: "auto" };
    } else {
      bodyObj.temperature = 0.3;
    }

    const body = JSON.stringify(bodyObj);

    console.log(`[ai-stream] Calling ${config.label} (${model}) via Responses API at ${url}`);
    const response = await fetch(url, { method: "POST", headers: copilotHeaders, body, signal });

    // Capture rate limit headers for usage tracking
    captureCopilotRateLimits(response.headers);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`);
    }

    if (!response.body) {
      throw new Error("No response body for streaming");
    }

    // Parse Responses API SSE stream — extract text deltas and function calls
    // Responses API accumulates function calls differently — we track them via output_index
    const responsesToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    return parseSSEStream(
      response.body,
      (parsed) => {
        const type = parsed.type as string | undefined;
        if (type === "response.output_text.delta") {
          return (parsed.delta as string) ?? null;
        }
        // Track function call starts
        if (type === "response.function_call_arguments.delta") {
          const outputIndex = parsed.output_index as number ?? 0;
          const existing = responsesToolCalls.get(outputIndex);
          if (existing) {
            existing.arguments += (parsed.delta as string) ?? "";
          }
          return null;
        }
        if (type === "response.output_item.added") {
          const item = parsed.item as { type?: string; call_id?: string; name?: string } | undefined;
          if (item?.type === "function_call" && item.call_id) {
            const outputIndex = parsed.output_index as number ?? 0;
            responsesToolCalls.set(outputIndex, { id: item.call_id, name: item.name ?? "", arguments: "" });
          }
          return null;
        }
        if (type === "error") {
          const errMsg = (parsed.message as string) ?? "Unknown error";
          throw new Error(`Copilot Responses API error: ${errMsg}`);
        }
        return null;
      },
      onToken,
      signal,
      // Extract usage from response.completed event
      (parsed) => {
        const type = parsed.type as string | undefined;
        if (type === "response.completed") {
          const resp = parsed.response as { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } } | undefined;
          const u = resp?.usage;
          if (u && typeof u.input_tokens === "number") {
            return {
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens ?? 0,
              totalTokens: u.total_tokens ?? (u.input_tokens + (u.output_tokens ?? 0))
            };
          }
        }
        return null;
      }
    ).then((result) => {
      // Merge Responses API function calls into the result
      if (responsesToolCalls.size > 0) {
        result.toolCalls = [...(result.toolCalls ?? []), ...Array.from(responsesToolCalls.values())];
      }
      return result;
    });
  } else {
    // --- Chat Completions API for non-GPT-5 models ---
    const url = `${config.baseUrl}/chat/completions`;

    const bodyObj: Record<string, unknown> = {
      model,
      messages: messages.map((m) => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) { msg.tool_call_id = m.tool_call_id; msg.name = m.name; }
        return msg;
      }),
      max_tokens: 16384,
      stream: true,
      stream_options: { include_usage: true },
      tools: AI_TOOLS_OPENAI,
      tool_choice: "auto",
    };

    // Reasoning models (o1, o3, o4): no temperature
    if (!isReasoning) {
      bodyObj.temperature = 0.3;
    }

    const body = JSON.stringify(bodyObj);

    console.log(`[ai-stream] Calling ${config.label} (${model}) via Chat Completions at ${url}`);
    const response = await fetch(url, { method: "POST", headers: copilotHeaders, body, signal });

    // Capture rate limit headers for usage tracking
    captureCopilotRateLimits(response.headers);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      if (response.status === 400 && errorBody.includes("unsupported_api_for_model")) {
        throw new Error(`Model "${model}" is not compatible with the chat/completions API. It may require the Responses API.`);
      }
      throw new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`);
    }

    if (!response.body) {
      throw new Error("No response body for streaming");
    }

    return parseSSEStream(
      response.body,
      (parsed) => {
        const choices = parsed.choices as Array<{ delta?: { content?: string } }> | undefined;
        return choices?.[0]?.delta?.content ?? null;
      },
      onToken,
      signal,
      // Extract usage from the final chunk
      (parsed) => {
        const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
        if (usage && typeof usage.prompt_tokens === "number") {
          return {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens ?? 0,
            totalTokens: usage.total_tokens ?? (usage.prompt_tokens + (usage.completion_tokens ?? 0))
          };
        }
        return null;
      },
      // Extract tool call deltas
      (parsed) => {
        const choices = parsed.choices as Array<{
          delta?: { tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
        }> | undefined;
        const tc = choices?.[0]?.delta?.tool_calls?.[0];
        if (!tc) return null;
        return { index: tc.index, id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments };
      }
    );
  }
}

async function callAnthropicStream(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: TokenCallback,
  signal?: AbortSignal
): Promise<StreamResult> {
  const url = `${config.baseUrl}/messages`;

  const systemMessage = messages.find((m) => m.role === "system");

  // Build Anthropic-format messages — handle tool_use and tool_result content blocks
  const chatMessages: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      // Assistant message with tool calls — Anthropic uses content blocks
      const content: Array<Record<string, unknown>> = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        let inputObj: unknown;
        try { inputObj = JSON.parse(tc.function.arguments); } catch { inputObj = {}; }
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: inputObj });
      }
      chatMessages.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      // Tool result — Anthropic uses tool_result content blocks in a "user" message
      chatMessages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }] });
    } else {
      chatMessages.push({ role: m.role as "user" | "assistant", content: m.content });
    }
  }

  if (chatMessages.length > 0 && chatMessages[0].role !== "user") {
    chatMessages.unshift({ role: "user", content: "(start)" });
  }

  const body = JSON.stringify({
    model,
    max_tokens: 16384,
    system: systemMessage?.content ?? getSystemPrompt(),
    messages: chatMessages,
    stream: true,
    tools: AI_TOOLS_ANTHROPIC,
    tool_choice: { type: "auto" }
  });

  console.log(`[ai-stream] Calling ${config.label} (${model}) at ${url}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body,
    signal
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`);
  }

  if (!response.body) {
    throw new Error("No response body for streaming");
  }

  // Anthropic SSE format: content_block_start/delta/stop for text and tool_use blocks
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let inputTokens = 0;
  let outputTokens = 0;
  // Track tool_use blocks by index
  const toolBlocks = new Map<number, { id: string; name: string; arguments: string }>();
  let currentBlockIndex = -1;
  let currentBlockType = "";

  try {
  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6);
      if (payload === "[DONE]") continue;

      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        const type = parsed.type as string | undefined;
        const error = parsed.error as { message?: string } | undefined;
        if (error) {
          throw new Error(error.message ?? "Anthropic streaming error");
        }

        // content_block_start — track block type
        if (type === "content_block_start") {
          const idx = parsed.index as number ?? 0;
          const block = parsed.content_block as { type?: string; id?: string; name?: string } | undefined;
          currentBlockIndex = idx;
          currentBlockType = block?.type ?? "";
          if (currentBlockType === "tool_use" && block?.id) {
            toolBlocks.set(idx, { id: block.id, name: block.name ?? "", arguments: "" });
          }
        }
        // content_block_delta — text or tool input JSON
        if (type === "content_block_delta") {
          const delta = parsed.delta as { type?: string; text?: string; partial_json?: string } | undefined;
          if (delta?.type === "text_delta" && delta.text) {
            fullContent += delta.text;
            onToken(delta.text);
          }
          if (delta?.type === "input_json_delta" && delta.partial_json) {
            const idx = parsed.index as number ?? currentBlockIndex;
            const block = toolBlocks.get(idx);
            if (block) block.arguments += delta.partial_json;
          }
        }
        // Capture input tokens from message_start
        if (type === "message_start") {
          const msg = parsed.message as { usage?: { input_tokens?: number } } | undefined;
          if (msg?.usage?.input_tokens) inputTokens = msg.usage.input_tokens;
        }
        // Capture output tokens from message_delta
        if (type === "message_delta") {
          const usage = parsed.usage as { output_tokens?: number } | undefined;
          if (usage?.output_tokens) outputTokens = usage.output_tokens;
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("streaming error")) throw e;
        // skip malformed lines
      }
    }
  }
  } catch (err) {
    if (signal?.aborted) {
      const usage = inputTokens > 0 ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } : undefined;
      const toolCalls = toolBlocks.size > 0 ? Array.from(toolBlocks.values()) : undefined;
      return { content: fullContent || "[Streaming aborted]", usage, toolCalls };
    }
    throw err;
  }

  const usage = inputTokens > 0 ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } : undefined;
  const toolCalls = toolBlocks.size > 0 ? Array.from(toolBlocks.values()) : undefined;
  return { content: fullContent || (toolCalls ? "" : "[No response from model]"), usage, toolCalls };
}

/** Callback for tool-related SSE events */
type ToolEventCallback = (event: {
  type: "tool_call" | "tool_result";
  toolCallId: string;
  toolName: string;
  arguments?: string;
  result?: string;
  isError?: boolean;
}) => void;

/** Streaming version of callAI — invokes onToken for each chunk, supports tool execution loop.
 *  When the AI returns tool calls, it executes them and sends results back for another round. */
async function callAIStream(
  providerLabel: string,
  uiModel: string,
  messages: ChatMessage[],
  onToken: TokenCallback,
  fileContext?: string,
  signal?: AbortSignal,
  onToolEvent?: ToolEventCallback
): Promise<StreamResult> {
  const config = resolveProvider(providerLabel);
  if (!config) {
    const errMsg = `[Error] Unknown provider: ${providerLabel}. Available: ${providerConfigs.map((c) => c.label).join(", ")}`;
    onToken(errMsg);
    return { content: errMsg };
  }

  const apiKey = await getKeyForProviderAsync(config.id);
  if (!apiKey) {
    const errMsg = `[Error] No API key set for ${config.label}. Go to Settings in the sidebar to add your API key, or set the ${config.envKey} environment variable and restart the server.`;
    onToken(errMsg);
    return { content: errMsg };
  }

  const model = resolveModel(config, uiModel);

  // Build messages with system prompt, workspace file tree, and optional file context
  const basePrompt = getSystemPrompt();
  const fileTree = await getWorkspaceFileTree();
  let systemContent = basePrompt + fileTree;
  if (fileContext) {
    systemContent += `\n\nThe user currently has this file open:\n\`\`\`\n${fileContext}\n\`\`\``;
  }

  const chatMessages: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...messages
  ];

  // Tool execution loop — up to 15 rounds of tool calls
  const MAX_TOOL_ROUNDS = 15;
  let allContent = "";
  let lastUsage: UsageData | undefined;
  const allToolCalls: Array<{ id: string; name: string; arguments: string }> = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    try {
      let result: StreamResult;
      if (config.format === "anthropic") {
        result = await callAnthropicStream(config, apiKey, model, chatMessages, onToken, signal);
      } else if (config.format === "copilot") {
        result = await callCopilotStream(config, apiKey, model, chatMessages, onToken, signal);
      } else {
        result = await callOpenAICompatibleStream(config, apiKey, model, chatMessages, onToken, signal);
      }

      trackLocalUsage(config.id, result.usage);
      allContent += result.content;
      if (result.usage) {
        if (lastUsage) {
          lastUsage.inputTokens += result.usage.inputTokens;
          lastUsage.outputTokens += result.usage.outputTokens;
          lastUsage.totalTokens += result.usage.totalTokens;
        } else {
          lastUsage = { ...result.usage };
        }
      }

      // If no tool calls, we're done
      if (!result.toolCalls || result.toolCalls.length === 0) {
        return { content: allContent, usage: lastUsage, toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined };
      }

      // Process tool calls
      console.log(`[ai-stream] Round ${round + 1}: AI returned ${result.toolCalls.length} tool call(s)`);

      // Add the assistant message with tool calls to conversation
      const assistantToolCalls = result.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments }
      }));
      chatMessages.push({
        role: "assistant",
        content: result.content,
        tool_calls: assistantToolCalls
      });

      // Execute each tool call and append results
      for (const tc of result.toolCalls) {
        allToolCalls.push(tc);

        // Notify client that a tool call is starting
        if (onToolEvent) {
          onToolEvent({ type: "tool_call", toolCallId: tc.id, toolName: tc.name, arguments: tc.arguments });
        }

        const toolResult = await executeTool(tc.name, tc.arguments);

        // Notify client of the tool result
        if (onToolEvent) {
          onToolEvent({ type: "tool_result", toolCallId: tc.id, toolName: tc.name, result: toolResult.result, isError: toolResult.isError });
        }

        // Add tool result to conversation for the next AI round
        chatMessages.push({
          role: "tool",
          content: toolResult.result,
          tool_call_id: tc.id,
          name: tc.name
        });
      }

      // Continue to next round — AI will see the tool results and continue
    } catch (error) {
      if (signal?.aborted) {
        return { content: allContent || "[Streaming aborted]", usage: lastUsage };
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ai-stream] ${config.label} error (round ${round + 1}):`, message);
      const errMsg = `[Error] ${config.label} API call failed: ${message}`;
      onToken(errMsg);
      return { content: allContent + errMsg, usage: lastUsage };
    }
  }

  // If we hit max rounds, return what we have
  console.warn(`[ai-stream] Hit max tool rounds (${MAX_TOOL_ROUNDS})`);
  return { content: allContent, usage: lastUsage, toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined };
}

/* ================================================================
   Helpers (unchanged)
   ================================================================ */

type JsonResponse = ServerResponse;

function sendJson(response: JsonResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS"
  });
  response.end(JSON.stringify(payload));
}

async function collectFiles(directory: string): Promise<FileEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: FileEntry[] = [];

  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath)));
      continue;
    }

    const extension = path.extname(entry.name);
    if (!allowedExtensions.has(extension)) continue;

    const relativePath = path.relative(workspaceRoot, absolutePath);
    const content = await readFile(absolutePath, "utf8");
    files.push({
      id: relativePath,
      name: path.basename(relativePath),
      path: relativePath,
      folder: path.dirname(relativePath),
      language: languageFromExtension(extension),
      content
    });
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function languageFromExtension(extension: string) {
  switch (extension) {
    case ".ts": case ".tsx": return "typescript";
    case ".js": case ".jsx": return "javascript";
    case ".css": return "css";
    case ".json": return "json";
    case ".md": return "markdown";
    case ".html": return "html";
    case ".yml": case ".yaml": return "yaml";
    default: return "plaintext";
  }
}

function toSummary(session: StoredSession): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    provider: session.provider,
    model: session.model,
    updatedAt: session.updatedAt
  };
}

function getRecentRuns() {
  return Array.from(commandRunStore.values())
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, 8);
}

function attachMessage(
  session: StoredSession,
  role: "user" | "assistant" | "system" | "tool",
  content: string,
  extra?: {
    toolCalls?: ToolCall[];
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  }
) {
  session.messages.push({
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    ...(extra?.toolCalls ? { toolCalls: extra.toolCalls } : {}),
    ...(extra?.toolCallId ? { toolCallId: extra.toolCallId } : {}),
    ...(extra?.toolName ? { toolName: extra.toolName } : {}),
    ...(extra?.isError !== undefined ? { isError: extra.isError } : {})
  });
  session.updatedAt = new Date().toISOString();
}

async function buildWorkspaceSnapshot() {
  const files = await collectFiles(workspaceRoot);
  const sessions = Array.from(sessionStore.values())
    .filter((s) => s.workspace === workspaceRoot)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(toSummary);

  // Detect git branch
  let branch: string | undefined;
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: workspaceRoot, encoding: "utf8" }).trim();
  } catch {
    // Not a git repo or git not available
  }

  return workspaceSnapshotSchema.parse({
    workspace: {
      id: "alpha-code",
      name: path.basename(workspaceRoot),
      root: workspaceRoot,
      branch,
      files
    },
    sessions,
    suggestions: promptSuggestions,
    recentRuns: getRecentRuns(),
    providers: await Promise.all(providerConfigs.map(async (config) => ({
      id: config.id,
      label: config.label,
      status: getProviderStatus(config),
      model: config.defaultModel,
      models: await getModelsForProvider(config),
      method: getAuthMethod(config)
    })))
  });
}

async function readJsonBody(request: AsyncIterable<string | Buffer>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? textEncoder.encode(chunk) : chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function runCommand(command: string, sessionId?: string) {
  const startedAt = new Date().toISOString();
  const run: CommandRun = {
    id: randomUUID(),
    sessionId,
    command,
    status: "running",
    output: `$ ${command}\n`,
    exitCode: null,
    startedAt,
    finishedAt: null
  };

  commandRunStore.set(run.id, run);
  const emitter = getTerminalEmitter(run.id);

  const shell = process.env.SHELL || "/bin/zsh";
  const child = spawn(shell, ["-lc", command], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      PATH: `/Users/aarushtanwar/.nvm/versions/node/v20.20.0/bin:${process.env.PATH ?? ""}`
    }
  });

  // Store child process for potential killing
  activeChildProcesses.set(run.id, child);

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    run.output += text;
    commandRunStore.set(run.id, { ...run });
    emitter.emit("data", text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    run.output += text;
    commandRunStore.set(run.id, { ...run });
    emitter.emit("data", text);
  });

  child.on("close", (code, signal) => {
    run.status = signal ? "killed" : code === 0 ? "completed" : "failed";
    run.exitCode = code;
    run.finishedAt = new Date().toISOString();
    if (signal) {
      run.output += `\nProcess terminated with signal ${signal}.`;
      emitter.emit("data", `\nProcess terminated with signal ${signal}.`);
    }
    commandRunStore.set(run.id, { ...run });
    emitter.emit("close", { status: run.status, exitCode: code });

    // Clean up child process reference and emitter after a short delay
    activeChildProcesses.delete(run.id);
    setTimeout(() => { terminalEmitters.delete(run.id); }, 2000);

    if (sessionId) {
      const session = sessionStore.get(sessionId);
      if (session) {
        session.commandRuns = [run, ...session.commandRuns.filter((item) => item.id !== run.id)].slice(0, 12);
        session.status = run.status === "completed" ? "idle" : "review";
        attachMessage(
          session,
          "system",
          `Command ${run.status}: ${command}${typeof code === "number" ? ` (exit ${code})` : ""}`
        );
        sessionStore.set(session.id, { ...session });
        persistSessions();
      }
    }
  });

  return run;
}

async function getDirectoryChildren(relativeDir: string) {
  const absoluteDir = path.resolve(workspaceRoot, relativeDir);
  if (!absoluteDir.startsWith(workspaceRoot)) return [];

  const entries = await readdir(absoluteDir, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => !ignoredDirectories.has(entry.name))
      .map(async (entry) => {
        const absolutePath = path.join(absoluteDir, entry.name);
        const entryStat = await stat(absolutePath);
        return {
          name: entry.name,
          path: path.relative(workspaceRoot, absolutePath),
          type: entry.isDirectory() ? "directory" : "file",
          size: entry.isDirectory() ? null : entryStat.size
        };
      })
  );
}

/* ================================================================
   Helper: read file content for AI context
   ================================================================ */

async function readFileContext(filePath?: string): Promise<string | undefined> {
  if (!filePath) return undefined;
  try {
    const absolutePath = path.resolve(workspaceRoot, filePath);
    if (!absolutePath.startsWith(workspaceRoot)) return undefined;
    const content = await readFile(absolutePath, "utf8");
    // Limit context to ~8000 chars to avoid token limits
    return content.length > 8000 ? content.slice(0, 8000) + "\n... (truncated)" : content;
  } catch {
    return undefined;
  }
}

/* ================================================================
   HTTP Server
   ================================================================ */

const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS"
      });
      response.end();
      return;
    }

    if (request.url === "/health") {
      const payload = healthResponseSchema.parse({
        ok: true,
        appName: APP_NAME,
        timestamp: new Date().toISOString()
      });
      sendJson(response, 200, payload);
      return;
    }

    if (request.method === "GET" && request.url === "/") {
      sendJson(response, 200, {
        ok: true,
        appName: APP_NAME,
        message: "Alpha Code local runtime is running.",
        webUrl: "http://127.0.0.1:3000",
        endpoints: ["/health", "/api/workspace", "/api/sessions/:id", "/api/file", "/api/terminal/runs", "/api/fs?path=apps"]
      });
      return;
    }

    if (request.method === "GET" && request.url === "/api/workspace") {
      sendJson(response, 200, await buildWorkspaceSnapshot());
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/api/fs")) {
      const url = new URL(request.url, `http://localhost:${port}`);
      const dir = url.searchParams.get("path") ?? ".";
      sendJson(response, 200, { path: dir, children: await getDirectoryChildren(dir) });
      return;
    }

    if (request.method === "GET" && request.url === "/api/provider-usage") {
      const usage = await getAllProviderUsage();
      sendJson(response, 200, { providers: usage });
      return;
    }

    /* ---- Workspace / project management ---- */

    if (request.method === "GET" && request.url === "/api/workspace") {
      sendJson(response, 200, {
        root: workspaceRoot,
        name: path.basename(workspaceRoot),
      });
      return;
    }

    if (request.method === "GET" && request.url === "/api/workspace/recent") {
      sendJson(response, 200, { projects: recentProjects });
      return;
    }

    if (request.method === "POST" && request.url === "/api/workspace/switch") {
      const payload = await readJsonBody(request);
      const targetPath = typeof payload.path === "string" ? (payload.path as string).trim() : "";
      if (!targetPath) {
        sendJson(response, 400, { error: "Missing 'path' field" });
        return;
      }
      const resolved = path.resolve(targetPath);
      try {
        const s = await stat(resolved);
        if (!s.isDirectory()) {
          sendJson(response, 400, { error: "Path is not a directory" });
          return;
        }
      } catch {
        sendJson(response, 400, { error: "Path does not exist" });
        return;
      }
      workspaceRoot = resolved;
      touchProject(resolved);
      console.log(`[workspace] Switched to ${resolved}`);
      sendJson(response, 200, {
        root: workspaceRoot,
        name: path.basename(workspaceRoot),
      });
      return;
    }

    /* ---- Git branch management ---- */

    if (request.method === "GET" && request.url === "/api/git/branches") {
      try {
        const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: workspaceRoot, encoding: "utf8" }).trim();

        // Local branches
        const localRaw = execSync("git branch --format='%(refname:short)'", { cwd: workspaceRoot, encoding: "utf8" }).trim();
        const localBranches = localRaw ? localRaw.split("\n").map((b) => b.trim()).filter(Boolean) : [];

        // Remote branches (strip "origin/" prefix, deduplicate with local)
        let remoteBranches: string[] = [];
        try {
          const remoteRaw = execSync("git branch -r --format='%(refname:short)'", { cwd: workspaceRoot, encoding: "utf8" }).trim();
          remoteBranches = remoteRaw
            ? remoteRaw.split("\n")
                .map((b) => b.trim())
                .filter((b) => b && !b.includes("HEAD"))
                .map((b) => b.replace(/^origin\//, ""))
                .filter((b) => !localBranches.includes(b))
            : [];
        } catch { /* no remotes */ }

        // Check for uncommitted changes
        const statusRaw = execSync("git status --porcelain", { cwd: workspaceRoot, encoding: "utf8" }).trim();
        const hasUncommittedChanges = statusRaw.length > 0;

        sendJson(response, 200, {
          current: currentBranch,
          local: localBranches,
          remote: remoteBranches,
          hasUncommittedChanges,
        });
      } catch (err) {
        sendJson(response, 500, { error: "Not a git repository or git not available" });
      }
      return;
    }

    if (request.method === "POST" && request.url === "/api/git/checkout") {
      try {
        const body = await readJsonBody(request) as { branch: string };
        if (!body.branch || typeof body.branch !== "string") {
          sendJson(response, 400, { error: "Missing branch name" });
          return;
        }
        const safeBranch = body.branch.replace(/[^a-zA-Z0-9._\-\/]/g, "");
        if (!safeBranch) {
          sendJson(response, 400, { error: "Invalid branch name" });
          return;
        }

        // Check if it's a local branch
        const localRaw = execSync("git branch --format='%(refname:short)'", { cwd: workspaceRoot, encoding: "utf8" }).trim();
        const localBranches = localRaw ? localRaw.split("\n").map((b) => b.trim()) : [];

        let output: string;
        if (localBranches.includes(safeBranch)) {
          output = execSync(`git checkout "${safeBranch}"`, { cwd: workspaceRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
        } else {
          // Try checking out remote branch as tracking branch
          output = execSync(`git checkout -b "${safeBranch}" "origin/${safeBranch}"`, { cwd: workspaceRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
        }

        const newBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: workspaceRoot, encoding: "utf8" }).trim();
        sendJson(response, 200, { branch: newBranch, output });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(response, 400, { error: `Checkout failed: ${message}` });
      }
      return;
    }

    if (request.method === "POST" && request.url === "/api/git/branch") {
      try {
        const body = await readJsonBody(request) as { name: string; checkout?: boolean; from?: string };
        if (!body.name || typeof body.name !== "string") {
          sendJson(response, 400, { error: "Missing branch name" });
          return;
        }
        const safeName = body.name.replace(/[^a-zA-Z0-9._\-\/]/g, "");
        if (!safeName) {
          sendJson(response, 400, { error: "Invalid branch name" });
          return;
        }

        const fromRef = body.from ? body.from.replace(/[^a-zA-Z0-9._\-\/]/g, "") : "";
        const createCmd = fromRef
          ? `git branch "${safeName}" "${fromRef}"`
          : `git branch "${safeName}"`;

        execSync(createCmd, { cwd: workspaceRoot, encoding: "utf8" });

        if (body.checkout !== false) {
          execSync(`git checkout "${safeName}"`, { cwd: workspaceRoot, encoding: "utf8" });
        }

        const newBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: workspaceRoot, encoding: "utf8" }).trim();
        sendJson(response, 201, { branch: newBranch, created: safeName });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(response, 400, { error: `Branch creation failed: ${message}` });
      }
      return;
    }

    if (request.method === "POST" && request.url === "/api/sessions") {
      const payload = createSessionSchema.parse(await readJsonBody(request));
      const now = new Date().toISOString();
      const id = randomUUID();
      const session: StoredSession = {
        id,
        title: payload.prompt.slice(0, 72),
        status: "running",
        provider: payload.provider,
        model: payload.model,
        activeFilePath: payload.filePath,
        updatedAt: now,
        messages: [],
        commandRuns: [],
        workspace: workspaceRoot
      };

      attachMessage(session, "user", payload.prompt);
      sessionStore.set(id, session);
      persistSessions();

      // Send immediate response with user message, then stream AI in background
      const fileContext = await readFileContext(payload.filePath);
      const conversationMessages: ChatMessage[] = [{ role: "user", content: payload.prompt }];

      const emitter = getSessionEmitter(id);
      const messageId = randomUUID();

      // Create abort controller for this streaming request
      const abortController = new AbortController();
      activeAbortControllers.set(id, abortController);

      // Track tool calls and results to store them in session after completion
      const pendingToolMessages: Array<{
        role: "assistant" | "tool";
        content: string;
        extra?: Parameters<typeof attachMessage>[3];
      }> = [];

      callAIStream(payload.provider, payload.model, conversationMessages, (token) => {
        emitter.emit("token", { messageId, token });
      }, fileContext, abortController.signal, (toolEvent) => {
        // Forward tool events to SSE stream
        emitter.emit(toolEvent.type, { messageId, ...toolEvent });
        // Accumulate tool messages for session persistence
        if (toolEvent.type === "tool_call") {
          // Store the assistant message that requested this tool call
          pendingToolMessages.push({
            role: "assistant",
            content: "",
            extra: {
              toolCalls: [{
                id: toolEvent.toolCallId,
                name: toolEvent.toolName,
                arguments: toolEvent.arguments || "{}"
              }]
            }
          });
        } else if (toolEvent.type === "tool_result") {
          pendingToolMessages.push({
            role: "tool",
            content: toolEvent.result || "",
            extra: {
              toolCallId: toolEvent.toolCallId,
              toolName: toolEvent.toolName,
              isError: toolEvent.isError
            }
          });
        }
      }).then((result) => {
        activeAbortControllers.delete(id);
        // Store intermediate tool messages into the session
        for (const tm of pendingToolMessages) {
          attachMessage(session, tm.role, tm.content, tm.extra);
        }
        attachMessage(session, "assistant", result.content);
        session.status = "idle";
        sessionStore.set(id, { ...session });
        persistSessions();
        emitter.emit("done", { messageId, usage: result.usage });
        console.log(`[ai-stream] Session ${id} got reply (${result.content.length} chars)${result.usage ? ` [${result.usage.inputTokens}+${result.usage.outputTokens} tokens]` : ""}`);
      }).catch((error) => {
        activeAbortControllers.delete(id);
        // Still store any tool messages that happened before the error
        for (const tm of pendingToolMessages) {
          attachMessage(session, tm.role, tm.content, tm.extra);
        }
        const message = error instanceof Error ? error.message : String(error);
        attachMessage(session, "assistant", `[Error] AI call failed: ${message}`);
        session.status = "review";
        sessionStore.set(id, { ...session });
        persistSessions();
        emitter.emit("error", { messageId, error: message });
      });

      sendJson(response, 201, { ...session, streamMessageId: messageId });
      return;
    }

    if (request.method === "POST" && request.url === "/api/messages") {
      const payload = appendMessageSchema.parse(await readJsonBody(request));
      const session = sessionStore.get(payload.sessionId);
      if (!session) {
        sendJson(response, 404, { error: "Session not found" });
        return;
      }

      session.provider = payload.provider;
      session.model = payload.model;
      session.activeFilePath = payload.filePath;
      session.status = "running";
      attachMessage(session, "user", payload.prompt);
      sessionStore.set(session.id, { ...session });
      persistSessions();

      // Build conversation history for context — include tool messages for full context
      const conversationMessages: ChatMessage[] = session.messages
        .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
        .map((m) => {
          const msg: ChatMessage = { role: m.role as "user" | "assistant" | "tool", content: m.content };
          if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
            msg.tool_calls = m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments }
            }));
          }
          if (m.role === "tool" && m.toolCallId) {
            msg.tool_call_id = m.toolCallId;
            msg.name = m.toolName;
          }
          return msg;
        });

      const fileContext = await readFileContext(payload.filePath);
      const emitter = getSessionEmitter(session.id);
      const messageId = randomUUID();

      // Create abort controller for this streaming request
      const abortController = new AbortController();
      activeAbortControllers.set(session.id, abortController);

      // Track tool calls and results to store them in session after completion
      const pendingToolMessages: Array<{
        role: "assistant" | "tool";
        content: string;
        extra?: Parameters<typeof attachMessage>[3];
      }> = [];

      // Streaming AI call
      callAIStream(payload.provider, payload.model, conversationMessages, (token) => {
        emitter.emit("token", { messageId, token });
      }, fileContext, abortController.signal, (toolEvent) => {
        // Forward tool events to SSE stream
        emitter.emit(toolEvent.type, { messageId, ...toolEvent });
        // Accumulate tool messages for session persistence
        if (toolEvent.type === "tool_call") {
          pendingToolMessages.push({
            role: "assistant",
            content: "",
            extra: {
              toolCalls: [{
                id: toolEvent.toolCallId,
                name: toolEvent.toolName,
                arguments: toolEvent.arguments || "{}"
              }]
            }
          });
        } else if (toolEvent.type === "tool_result") {
          pendingToolMessages.push({
            role: "tool",
            content: toolEvent.result || "",
            extra: {
              toolCallId: toolEvent.toolCallId,
              toolName: toolEvent.toolName,
              isError: toolEvent.isError
            }
          });
        }
      }).then((result) => {
        activeAbortControllers.delete(session.id);
        // Store intermediate tool messages into the session
        for (const tm of pendingToolMessages) {
          attachMessage(session, tm.role, tm.content, tm.extra);
        }
        attachMessage(session, "assistant", result.content);
        session.status = "idle";
        sessionStore.set(session.id, { ...session });
        persistSessions();
        emitter.emit("done", { messageId, usage: result.usage });
        console.log(`[ai-stream] Session ${session.id} got reply (${result.content.length} chars)${result.usage ? ` [${result.usage.inputTokens}+${result.usage.outputTokens} tokens]` : ""}`);
      }).catch((error) => {
        activeAbortControllers.delete(session.id);
        // Still store any tool messages that happened before the error
        for (const tm of pendingToolMessages) {
          attachMessage(session, tm.role, tm.content, tm.extra);
        }
        const message = error instanceof Error ? error.message : String(error);
        attachMessage(session, "assistant", `[Error] AI call failed: ${message}`);
        session.status = "review";
        sessionStore.set(session.id, { ...session });
        persistSessions();
        emitter.emit("error", { messageId, error: message });
      });

      sendJson(response, 200, { ...session, streamMessageId: messageId });
      return;
    }

    /* DELETE /api/messages/:id — delete a message from its session */
    if (request.method === "DELETE" && request.url?.match(/^\/api\/messages\/[^/]+$/)) {
      const messageId = request.url.split("/")[3];
      let found = false;
      for (const session of sessionStore.values()) {
        const index = session.messages.findIndex((m) => m.id === messageId);
        if (index !== -1) {
          session.messages.splice(index, 1);
          sessionStore.set(session.id, { ...session });
          persistSessions();
          found = true;
          break;
        }
      }
      sendJson(response, 200, { ok: true, deleted: found });
      return;
    }

    /* SSE stream endpoint — clients connect here to receive real-time tokens */
    if (request.method === "GET" && request.url?.match(/^\/api\/sessions\/[^/]+\/stream/)) {
      const sessionId = request.url.split("/")[3];
      const session = sessionStore.get(sessionId);
      if (!session) {
        sendJson(response, 404, { error: "Session not found" });
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS"
      });

      // Send initial connected event
      response.write(`data: ${JSON.stringify({ type: "connected", sessionId })}\n\n`);

      const emitter = getSessionEmitter(sessionId);

      const onToken = (payload: { messageId: string; token: string }) => {
        response.write(`data: ${JSON.stringify({ type: "token", messageId: payload.messageId, token: payload.token })}\n\n`);
      };
      const onDone = (payload: { messageId: string; usage?: UsageData }) => {
        response.write(`data: ${JSON.stringify({ type: "done", messageId: payload.messageId, usage: payload.usage })}\n\n`);
      };
      const onError = (payload: { messageId: string; error: string }) => {
        response.write(`data: ${JSON.stringify({ type: "error", messageId: payload.messageId, error: payload.error })}\n\n`);
      };
      const onToolCall = (payload: { messageId: string; toolCallId: string; toolName: string; arguments?: string }) => {
        response.write(`data: ${JSON.stringify({ type: "tool_call", messageId: payload.messageId, toolCallId: payload.toolCallId, toolName: payload.toolName, arguments: payload.arguments })}\n\n`);
      };
      const onToolResult = (payload: { messageId: string; toolCallId: string; toolName: string; result?: string; isError?: boolean }) => {
        response.write(`data: ${JSON.stringify({ type: "tool_result", messageId: payload.messageId, toolCallId: payload.toolCallId, toolName: payload.toolName, result: payload.result, isError: payload.isError })}\n\n`);
      };

      emitter.on("token", onToken);
      emitter.on("done", onDone);
      emitter.on("error", onError);
      emitter.on("tool_call", onToolCall);
      emitter.on("tool_result", onToolResult);

      // Cleanup when client disconnects
      request.on("close", () => {
        emitter.off("token", onToken);
        emitter.off("done", onDone);
        emitter.off("error", onError);
        emitter.off("tool_call", onToolCall);
        emitter.off("tool_result", onToolResult);
        // Clean up emitter if no listeners remain
        if (emitter.listenerCount("token") === 0) {
          sessionEmitters.delete(sessionId);
        }
      });

      return;
    }

    /* POST /api/sessions/:id/abort — cancel an in-flight AI streaming request */
    if (request.method === "POST" && request.url?.match(/^\/api\/sessions\/[^/]+\/abort$/)) {
      const sessionId = request.url.split("/")[3];
      const controller = activeAbortControllers.get(sessionId);
      if (controller) {
        controller.abort();
        activeAbortControllers.delete(sessionId);
        // Also emit a done event so the SSE client knows streaming ended
        const emitter = getSessionEmitter(sessionId);
        emitter.emit("done", { messageId: null, aborted: true });
        console.log(`[ai-stream] Aborted streaming for session ${sessionId}`);
      }
      const session = sessionStore.get(sessionId);
      if (session) {
        session.status = "idle";
        sessionStore.set(sessionId, { ...session });
        persistSessions();
      }
      sendJson(response, 200, { ok: true, aborted: !!controller });
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/api/sessions/")) {
      const sessionId = request.url.replace("/api/sessions/", "");
      const session = sessionStore.get(sessionId);
      if (!session) {
        sendJson(response, 404, { error: "Session not found" });
        return;
      }
      const mergedRuns = [
        ...session.commandRuns,
        ...getRecentRuns().filter((run) => run.sessionId === session.id && !session.commandRuns.some((item) => item.id === run.id))
      ].slice(0, 12);
      sendJson(response, 200, { ...session, commandRuns: mergedRuns });
      return;
    }

    if (request.method === "DELETE" && request.url?.startsWith("/api/sessions/")) {
      const sessionId = request.url.replace("/api/sessions/", "");
      // Abort any in-flight AI streaming
      const controller = activeAbortControllers.get(sessionId);
      if (controller) {
        controller.abort();
        activeAbortControllers.delete(sessionId);
      }
      const existed = sessionStore.delete(sessionId);
      persistSessions();
      // Also clean up any SSE emitter
      sessionEmitters.delete(sessionId);
      sendJson(response, 200, { ok: true, deleted: existed });
      return;
    }

    /* SSE stream for terminal output */
    if (request.method === "GET" && request.url?.match(/^\/api\/terminal\/runs\/[^/]+\/stream/)) {
      const runId = request.url.split("/")[4];
      const run = commandRunStore.get(runId);
      if (!run) {
        sendJson(response, 404, { error: "Run not found" });
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS"
      });

      // Send current output as initial payload
      response.write(`data: ${JSON.stringify({ type: "init", output: run.output, status: run.status })}\n\n`);

      // If already finished, send close immediately
      if (run.status !== "running") {
        response.write(`data: ${JSON.stringify({ type: "close", status: run.status, exitCode: run.exitCode })}\n\n`);
        response.end();
        return;
      }

      const emitter = getTerminalEmitter(runId);

      const onData = (text: string) => {
        response.write(`data: ${JSON.stringify({ type: "data", text })}\n\n`);
      };
      const onClose = (payload: { status: string; exitCode: number | null }) => {
        response.write(`data: ${JSON.stringify({ type: "close", status: payload.status, exitCode: payload.exitCode })}\n\n`);
        response.end();
      };

      emitter.on("data", onData);
      emitter.on("close", onClose);

      request.on("close", () => {
        emitter.off("data", onData);
        emitter.off("close", onClose);
      });

      return;
    }

    if (request.method === "GET" && request.url === "/api/terminal/runs") {
      sendJson(response, 200, { runs: getRecentRuns() });
      return;
    }

    if (request.method === "POST" && request.url === "/api/terminal/runs") {
      const payload = createCommandRunSchema.parse(await readJsonBody(request));
      const run = await runCommand(payload.command, payload.sessionId);
      if (payload.sessionId) {
        const session = sessionStore.get(payload.sessionId);
        if (session) {
          session.status = "running";
          session.commandRuns = [run, ...session.commandRuns.filter((item) => item.id !== run.id)].slice(0, 12);
          attachMessage(session, "system", `Running command: ${payload.command}`);
          sessionStore.set(session.id, { ...session });
          persistSessions();
        }
      }
      sendJson(response, 201, run);
      return;
    }

    /* DELETE /api/terminal/runs/:id — kill a running terminal process */
    if (request.method === "DELETE" && request.url?.match(/^\/api\/terminal\/runs\/[^/]+$/)) {
      const runId = request.url.split("/")[4];
      const run = commandRunStore.get(runId);
      if (!run) {
        sendJson(response, 404, { error: "Run not found" });
        return;
      }
      const child = activeChildProcesses.get(runId);
      if (child && run.status === "running") {
        child.kill("SIGTERM");
        // Give it 3s then SIGKILL
        setTimeout(() => {
          if (activeChildProcesses.has(runId)) {
            child.kill("SIGKILL");
          }
        }, 3000);
        sendJson(response, 200, { ok: true, killed: true });
      } else {
        sendJson(response, 200, { ok: true, killed: false, status: run.status });
      }
      return;
    }

    if (request.method === "PUT" && request.url === "/api/file") {
      const payload = (await readJsonBody(request)) as { path: string; content: string };
      const targetPath = path.resolve(workspaceRoot, payload.path);
      if (!targetPath.startsWith(workspaceRoot)) {
        sendJson(response, 400, { error: "Invalid file path" });
        return;
      }
      await writeFile(targetPath, payload.content, "utf8");
      sendJson(response, 200, { ok: true, path: payload.path });
      return;
    }

    /* ================================================================
       Auth Endpoints
       ================================================================ */

    // GET /api/auth/status — connection status of all providers
    if (request.method === "GET" && request.url === "/api/auth/status") {
      const providers = providerConfigs.map((config) => ({
        id: config.id as ProviderId,
        label: config.label,
        status: getProviderStatus(config),
        method: getAuthMethod(config)
      }));
      sendJson(response, 200, { providers });
      return;
    }

    // POST /api/auth/keys — save an API key for a provider
    if (request.method === "POST" && request.url === "/api/auth/keys") {
      const payload = saveKeyInputSchema.parse(await readJsonBody(request));
      storedKeys.set(payload.provider, payload.key);
      invalidateModelCache(payload.provider);
      console.log(`[auth] Stored API key for provider: ${payload.provider}`);
      void persistAuth();
      sendJson(response, 200, { ok: true, provider: payload.provider });
      return;
    }

    // DELETE /api/auth/keys/:provider — remove a stored key
    if (request.method === "DELETE" && request.url?.startsWith("/api/auth/keys/")) {
      const providerId = request.url.replace("/api/auth/keys/", "");
      storedKeys.delete(providerId);
      invalidateModelCache(providerId);
      console.log(`[auth] Removed stored key for provider: ${providerId}`);
      void persistAuth();
      sendJson(response, 200, { ok: true, provider: providerId });
      return;
    }

    // POST /api/auth/github/start — initiate GitHub OAuth Device Flow
    if (request.method === "POST" && request.url === "/api/auth/github/start") {
      try {
        const result = await startGitHubDeviceFlow();
        sendJson(response, 200, {
          deviceCode: result.deviceCode,
          userCode: result.userCode,
          verificationUri: result.verificationUri,
          expiresIn: result.expiresIn,
          interval: result.interval
        });
      } catch (err) {
        sendJson(response, 500, {
          error: err instanceof Error ? err.message : "Failed to start GitHub device flow"
        });
      }
      return;
    }

    // GET /api/auth/github/poll?device_code=X — poll for GitHub OAuth completion
    if (request.method === "GET" && request.url?.startsWith("/api/auth/github/poll")) {
      const url = new URL(request.url, `http://localhost:${port}`);
      const deviceCode = url.searchParams.get("device_code");
      if (!deviceCode) {
        sendJson(response, 400, { error: "Missing device_code parameter" });
        return;
      }
      const result = await pollGitHubDeviceFlow(deviceCode);
      // Don't send the actual token to the client for security
      sendJson(response, 200, {
        status: result.status,
        error: result.error,
        interval: result.interval
      });
      return;
    }

    sendJson(response, 404, { ok: false, appName: APP_NAME, message: "Not found" });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      appName: APP_NAME,
      message: error instanceof Error ? error.message : "Unknown server error"
    });
  }
});

/* ================================================================
   WebSocket PTY Terminal Server
   ================================================================ */

const WS_PORT = Number(process.env.WS_PORT ?? 3031);

// Active PTY sessions keyed by WebSocket
const activePtySessions = new Map<WebSocket, nodePty.IPty>();

function startTerminalServer(): void {
  const wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });

  wss.on("connection", (ws: WebSocket) => {
    const shell = process.env.SHELL || "/bin/zsh";
    let ptyProcess: nodePty.IPty;
    try {
      ptyProcess = nodePty.spawn(shell, [], {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        env: {
          ...process.env,
          PATH: `/Users/aarushtanwar/.nvm/versions/node/v20.20.0/bin:${process.env.PATH ?? ""}`,
          TERM: "xterm-256color"
        } as Record<string, string>
      });
    } catch (err) {
      console.error("[terminal] Failed to spawn PTY:", err instanceof Error ? err.message : err);
      ws.send(JSON.stringify({ type: "error", data: `Failed to spawn terminal: ${err instanceof Error ? err.message : String(err)}` }));
      ws.close();
      return;
    }

    activePtySessions.set(ws, ptyProcess);
    console.log(`[terminal] PTY spawned (pid: ${ptyProcess.pid}, shell: ${shell})`);

    // PTY → WebSocket (shell output)
    ptyProcess.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[terminal] PTY exited (code: ${exitCode}, signal: ${signal})`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", exitCode, signal }));
        ws.close();
      }
      activePtySessions.delete(ws);
    });

    // WebSocket → PTY (user input + resize)
    ws.on("message", (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as {
          type: string;
          data?: string;
          cols?: number;
          rows?: number;
        };

        if (msg.type === "input" && msg.data) {
          ptyProcess.write(msg.data);
        } else if (msg.type === "resize" && msg.cols && msg.rows) {
          ptyProcess.resize(msg.cols, msg.rows);
        }
      } catch {
        // If raw message is not JSON, treat it as direct input
        const text = typeof raw === "string" ? raw : raw.toString();
        ptyProcess.write(text);
      }
    });

    ws.on("close", () => {
      console.log("[terminal] WebSocket closed, killing PTY");
      ptyProcess.kill();
      activePtySessions.delete(ws);
    });

    ws.on("error", (err: Error) => {
      console.error("[terminal] WebSocket error:", err.message);
      ptyProcess.kill();
      activePtySessions.delete(ws);
    });
  });

  wss.on("error", (err: Error) => {
    console.error("[terminal] WebSocket server error:", err.message);
  });

  console.log(`[terminal] WebSocket PTY server listening on ws://127.0.0.1:${WS_PORT}`);
}

/* ================================================================
   Startup
   ================================================================ */

async function startServer(): Promise<void> {
  // Load persisted auth tokens from disk (GitHub OAuth, manual API keys)
  await loadPersistedAuth();

  // Load persisted sessions from disk
  await loadPersistedSessions();

  // Load recent projects list and mark the current workspace as active
  await loadPersistedProjects();
  touchProject(workspaceRoot);

  // Start WebSocket PTY terminal server
  startTerminalServer();

  // Log which providers are available
  const connectedProviders = providerConfigs.filter((c) => getKeyForProvider(c.id));
  const disconnectedProviders = providerConfigs.filter((c) => !getKeyForProvider(c.id));

  server.listen(port, "127.0.0.1", () => {
    console.log(`${APP_NAME} server listening on http://127.0.0.1:${port}`);
    if (connectedProviders.length > 0) {
      console.log(`[ai] Connected providers: ${connectedProviders.map((c) => c.label).join(", ")}`);
    }
    if (disconnectedProviders.length > 0) {
      console.log(`[ai] Missing API keys: ${disconnectedProviders.map((c) => `${c.label} (${c.envKey})`).join(", ")}`);
    }
  });
}

void startServer();
