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
  type SessionSummary
} from "@alpha-code/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "../../..");
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

const sessionStore = new Map<string, SessionDetail>();
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
  modelMap: Record<string, string>;
  format: "openai" | "anthropic" | "copilot";
}

const providerConfigs: ProviderConfig[] = [
  {
    id: "copilot",
    label: "Copilot",
    envKey: "GITHUB_TOKEN",
    baseUrl: "https://api.githubcopilot.com",
    defaultModel: "claude-sonnet-4",
    modelMap: {
      "Claude Sonnet 4": "claude-sonnet-4",
      "Claude Sonnet 4.5": "claude-sonnet-4.5",
      "Claude Opus 4": "claude-opus-4.5",
      "GPT-4.1": "gpt-4.1",
      "GPT-4o": "gpt-4o",
      "GPT-5": "gpt-5",
      "GPT-5 Mini": "gpt-5-mini",
      "Gemini 2.5 Pro": "gemini-2.5-pro",
      "Auto": "claude-sonnet-4"
    },
    format: "copilot"
  },
  {
    id: "openai",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    modelMap: {
      "GPT-4o": "gpt-4o",
      "GPT-4.1": "gpt-4.1-2025-04-14",
      "GPT-4.1 Mini": "gpt-4.1-mini-2025-04-14",
      "GPT-4.1 Nano": "gpt-4.1-nano-2025-04-14",
      "o4-mini": "o4-mini",
      "o3-mini": "o3-mini",
      "GPT-4o Mini": "gpt-4o-mini",
      "Auto": "gpt-4o"
    },
    format: "openai"
  },
  {
    id: "anthropic",
    label: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-20250514",
    modelMap: {
      "Claude Sonnet 4": "claude-sonnet-4-20250514",
      "Claude Opus 4": "claude-opus-4-20250514",
      "Claude 3.5 Sonnet": "claude-3-5-sonnet-20241022",
      "Claude Haiku 3.5": "claude-3-5-haiku-20241022",
      "Auto": "claude-sonnet-4-20250514"
    },
    format: "anthropic"
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o",
    modelMap: {
      "GPT-4o": "openai/gpt-4o",
      "GPT-4.1": "openai/gpt-4.1",
      "Claude Sonnet 4": "anthropic/claude-sonnet-4-20250514",
      "Claude Opus 4": "anthropic/claude-opus-4-20250514",
      "Gemini 2.5 Pro": "google/gemini-2.5-pro-preview",
      "Gemini 2.5 Flash": "google/gemini-2.5-flash-preview",
      "DeepSeek V3": "deepseek/deepseek-chat",
      "DeepSeek R1": "deepseek/deepseek-reasoner",
      "Llama 4 Maverick": "meta-llama/llama-4-maverick",
      "Auto": "openai/gpt-4o"
    },
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

function resolveProvider(providerLabel: string): ProviderConfig | null {
  return providerConfigs.find((c) => c.label === providerLabel) ?? null;
}

function resolveModel(config: ProviderConfig, uiModel: string): string {
  return config.modelMap[uiModel] ?? config.defaultModel;
}

const SYSTEM_PROMPT = `You are Alpha Code, an AI coding assistant running inside a local-first code editor. You help users with software engineering tasks: inspecting code, planning implementations, writing code, running commands, and reviewing changes.

Be concise and direct. Use markdown for code blocks. When suggesting file edits, show the exact code. When suggesting terminal commands, wrap them in \`\`\`bash blocks.

The user is working in a monorepo at: ${workspaceRoot}`;

/* ================================================================
   AI Completion — calls the selected provider
   ================================================================ */

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
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

  // Build messages with system prompt and optional file context
  const systemContent = fileContext
    ? `${SYSTEM_PROMPT}\n\nThe user currently has this file open:\n\`\`\`\n${fileContext}\n\`\`\``
    : SYSTEM_PROMPT;

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
    max_tokens: 4096,
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
    max_tokens: 4096,
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
    max_tokens: 4096,
    system: systemMessage?.content ?? SYSTEM_PROMPT,
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

/** Parse SSE lines from a readable stream, calling onToken for each content delta */
async function parseSSEStream(
  body: ReadableStream<Uint8Array>,
  extractDelta: (parsed: Record<string, unknown>) => string | null,
  onToken: TokenCallback,
  signal?: AbortSignal
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

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
      } catch {
        // skip malformed SSE lines
      }
    }
  }
  } catch (err) {
    // If aborted, return what we have so far
    if (signal?.aborted) {
      return fullContent || "[Streaming aborted]";
    }
    throw err;
  }

  return fullContent || "[No response from model]";
}

async function callOpenAICompatibleStream(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: TokenCallback,
  signal?: AbortSignal
): Promise<string> {
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
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: 4096,
    temperature: 0.3,
    stream: true
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
    signal
  );
}

async function callCopilotStream(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: TokenCallback,
  signal?: AbortSignal
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
    max_tokens: 4096,
    temperature: 0.3,
    stream: true
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
    signal
  );
}

async function callAnthropicStream(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: TokenCallback,
  signal?: AbortSignal
): Promise<string> {
  const url = `${config.baseUrl}/messages`;

  const systemMessage = messages.find((m) => m.role === "system");
  const chatMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  if (chatMessages.length > 0 && chatMessages[0].role !== "user") {
    chatMessages.unshift({ role: "user", content: "(start)" });
  }

  const body = JSON.stringify({
    model,
    max_tokens: 4096,
    system: systemMessage?.content ?? SYSTEM_PROMPT,
    messages: chatMessages,
    stream: true
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

  // Anthropic SSE format: event: content_block_delta + data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

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
        const parsed = JSON.parse(payload) as {
          type?: string;
          delta?: { type?: string; text?: string };
          error?: { message?: string };
        };
        if (parsed.error) {
          throw new Error(parsed.error.message ?? "Anthropic streaming error");
        }
        if (parsed.type === "content_block_delta" && parsed.delta?.text) {
          fullContent += parsed.delta.text;
          onToken(parsed.delta.text);
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("streaming error")) throw e;
        // skip malformed lines
      }
    }
  }
  } catch (err) {
    if (signal?.aborted) {
      return fullContent || "[Streaming aborted]";
    }
    throw err;
  }

  return fullContent || "[No response from model]";
}

/** Streaming version of callAI — invokes onToken for each chunk, returns full content */
async function callAIStream(
  providerLabel: string,
  uiModel: string,
  messages: ChatMessage[],
  onToken: TokenCallback,
  fileContext?: string,
  signal?: AbortSignal
): Promise<string> {
  const config = resolveProvider(providerLabel);
  if (!config) {
    const errMsg = `[Error] Unknown provider: ${providerLabel}. Available: ${providerConfigs.map((c) => c.label).join(", ")}`;
    onToken(errMsg);
    return errMsg;
  }

  const apiKey = await getKeyForProviderAsync(config.id);
  if (!apiKey) {
    const errMsg = `[Error] No API key set for ${config.label}. Go to Settings in the sidebar to add your API key, or set the ${config.envKey} environment variable and restart the server.`;
    onToken(errMsg);
    return errMsg;
  }

  const model = resolveModel(config, uiModel);

  const systemContent = fileContext
    ? `${SYSTEM_PROMPT}\n\nThe user currently has this file open:\n\`\`\`\n${fileContext}\n\`\`\``
    : SYSTEM_PROMPT;

  const chatMessages: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...messages
  ];

  try {
    if (config.format === "anthropic") {
      return await callAnthropicStream(config, apiKey, model, chatMessages, onToken, signal);
    }
    if (config.format === "copilot") {
      return await callCopilotStream(config, apiKey, model, chatMessages, onToken, signal);
    }
    return await callOpenAICompatibleStream(config, apiKey, model, chatMessages, onToken, signal);
  } catch (error) {
    if (signal?.aborted) {
      return "[Streaming aborted]";
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ai-stream] ${config.label} error:`, message);

    const errMsg = `[Error] ${config.label} API call failed: ${message}`;
    onToken(errMsg);
    return errMsg;
  }
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

function toSummary(session: SessionDetail): SessionSummary {
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

function attachMessage(session: SessionDetail, role: "user" | "assistant" | "system", content: string) {
  session.messages.push({
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString()
  });
  session.updatedAt = new Date().toISOString();
}

async function buildWorkspaceSnapshot() {
  const files = await collectFiles(workspaceRoot);
  const sessions = Array.from(sessionStore.values())
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
      name: APP_NAME,
      root: workspaceRoot,
      branch,
      files
    },
    sessions,
    suggestions: promptSuggestions,
    recentRuns: getRecentRuns(),
    providers: providerConfigs.map((config) => ({
      id: config.id,
      label: config.label,
      status: getProviderStatus(config),
      model: config.defaultModel,
      models: Object.keys(config.modelMap).filter((k) => k !== "Auto"),
      method: getAuthMethod(config)
    }))
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

    if (request.method === "POST" && request.url === "/api/sessions") {
      const payload = createSessionSchema.parse(await readJsonBody(request));
      const now = new Date().toISOString();
      const id = randomUUID();
      const session: SessionDetail = {
        id,
        title: payload.prompt.slice(0, 72),
        status: "running",
        provider: payload.provider,
        model: payload.model,
        activeFilePath: payload.filePath,
        updatedAt: now,
        messages: [],
        commandRuns: []
      };

      attachMessage(session, "user", payload.prompt);
      sessionStore.set(id, session);

      // Send immediate response with user message, then stream AI in background
      const fileContext = await readFileContext(payload.filePath);
      const conversationMessages: ChatMessage[] = [{ role: "user", content: payload.prompt }];

      const emitter = getSessionEmitter(id);
      const messageId = randomUUID();

      // Create abort controller for this streaming request
      const abortController = new AbortController();
      activeAbortControllers.set(id, abortController);

      callAIStream(payload.provider, payload.model, conversationMessages, (token) => {
        emitter.emit("token", { messageId, token });
      }, fileContext, abortController.signal).then((reply) => {
        activeAbortControllers.delete(id);
        attachMessage(session, "assistant", reply);
        session.status = "idle";
        sessionStore.set(id, { ...session });
        emitter.emit("done", { messageId });
        console.log(`[ai-stream] Session ${id} got reply (${reply.length} chars)`);
      }).catch((error) => {
        activeAbortControllers.delete(id);
        const message = error instanceof Error ? error.message : String(error);
        attachMessage(session, "assistant", `[Error] AI call failed: ${message}`);
        session.status = "review";
        sessionStore.set(id, { ...session });
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

      // Build conversation history for context
      const conversationMessages: ChatMessage[] = session.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      const fileContext = await readFileContext(payload.filePath);
      const emitter = getSessionEmitter(session.id);
      const messageId = randomUUID();

      // Create abort controller for this streaming request
      const abortController = new AbortController();
      activeAbortControllers.set(session.id, abortController);

      // Streaming AI call
      callAIStream(payload.provider, payload.model, conversationMessages, (token) => {
        emitter.emit("token", { messageId, token });
      }, fileContext, abortController.signal).then((reply) => {
        activeAbortControllers.delete(session.id);
        attachMessage(session, "assistant", reply);
        session.status = "idle";
        sessionStore.set(session.id, { ...session });
        emitter.emit("done", { messageId });
        console.log(`[ai-stream] Session ${session.id} got reply (${reply.length} chars)`);
      }).catch((error) => {
        activeAbortControllers.delete(session.id);
        const message = error instanceof Error ? error.message : String(error);
        attachMessage(session, "assistant", `[Error] AI call failed: ${message}`);
        session.status = "review";
        sessionStore.set(session.id, { ...session });
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
      const onDone = (payload: { messageId: string }) => {
        response.write(`data: ${JSON.stringify({ type: "done", messageId: payload.messageId })}\n\n`);
      };
      const onError = (payload: { messageId: string; error: string }) => {
        response.write(`data: ${JSON.stringify({ type: "error", messageId: payload.messageId, error: payload.error })}\n\n`);
      };

      emitter.on("token", onToken);
      emitter.on("done", onDone);
      emitter.on("error", onError);

      // Cleanup when client disconnects
      request.on("close", () => {
        emitter.off("token", onToken);
        emitter.off("done", onDone);
        emitter.off("error", onError);
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
      console.log(`[auth] Stored API key for provider: ${payload.provider}`);
      void persistAuth();
      sendJson(response, 200, { ok: true, provider: payload.provider });
      return;
    }

    // DELETE /api/auth/keys/:provider — remove a stored key
    if (request.method === "DELETE" && request.url?.startsWith("/api/auth/keys/")) {
      const providerId = request.url.replace("/api/auth/keys/", "");
      storedKeys.delete(providerId);
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
    const ptyProcess = nodePty.spawn(shell, [], {
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
