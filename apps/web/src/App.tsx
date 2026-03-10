import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import {
  Bot,
  Braces,
  ChevronDown,
  ChevronRight,
  Check,
  CircleAlert,
  Command,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode2,
  FileDiff,
  Files,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  Key,
  LoaderCircle,
  LogIn,
  LogOut,
  MessageSquare,
  Minus,
  Maximize2,
  PanelRight,
  Play,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Square,
  Terminal,
  TerminalSquare,
  Trash2,
  Wrench,
  X,
  Zap
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { APP_NAME, type AuthStatusResponse, type CommandRun, type GitHubDeviceCodeResponse, type GitHubPollResponse, type ProviderId, type SessionDetail, type WorkspaceSnapshot } from "@alpha-code/shared";

/* Electron preload exposes window.alphaCode on desktop */
interface AlphaCodeBridge {
  platform: "darwin" | "win32" | "linux";
  windowControl: (action: "minimize" | "maximize" | "close") => void;
  openExternal: (url: string) => void;
  pickFolder?: () => Promise<string | null>;
}
declare global {
  interface Window {
    alphaCode?: AlphaCodeBridge;
  }
}

const electronBridge = window.alphaCode ?? null;
const isElectron = electronBridge !== null;
const isMac = electronBridge?.platform === "darwin";

type FileItem = WorkspaceSnapshot["workspace"]["files"][number];
type DockTab = "terminal" | "changes" | "activity";
type SidebarTab = "chat" | "git";
type FsEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number | null;
};

const serverUrl = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3030";
const wsUrl = import.meta.env.VITE_WS_URL ?? "ws://127.0.0.1:3031";

/** Known model context window sizes (in tokens). Used for context usage indicator. */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // GPT-5 family
  "gpt-5": 1_000_000,
  "gpt-5.4": 1_000_000,
  "gpt-5-mini": 1_000_000,
  "gpt-5.2-codex": 1_000_000,
  "gpt-5.3-codex": 1_000_000,
  // GPT-4 family
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4.1": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-4.1-nano": 1_000_000,
  "gpt-4-turbo": 128_000,
  // Reasoning models
  "o1": 200_000,
  "o1-mini": 128_000,
  "o1-pro": 200_000,
  "o3": 200_000,
  "o3-mini": 200_000,
  "o4-mini": 200_000,
  // Claude family
  "claude-sonnet-4-20250514": 200_000,
  "claude-opus-4-20250514": 200_000,
  "claude-3.5-sonnet": 200_000,
  "claude-3-opus": 200_000,
  "claude-3-haiku": 200_000,
  "claude-3.5-haiku": 200_000,
  // Gemini
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-1.5-pro": 1_000_000,
  // Grok
  "grok-code-fast-1": 128_000,
  // ChatGPT
  "chatgpt-4o-latest": 128_000,
};

/** Get context limit for a model, falling back to fuzzy prefix match or default */
function getModelContextLimit(modelId: string): number {
  // Exact match
  if (MODEL_CONTEXT_LIMITS[modelId]) return MODEL_CONTEXT_LIMITS[modelId];
  // Strip date suffix and try again (e.g. "gpt-4o-2024-08-06" → "gpt-4o")
  const base = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
  if (MODEL_CONTEXT_LIMITS[base]) return MODEL_CONTEXT_LIMITS[base];
  // Prefix match
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (modelId.startsWith(key)) return limit;
  }
  // Default fallback
  return 128_000;
}

/** Format token count for display (e.g. 12345 → "12.3K", 1234567 → "1.2M") */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

const railItems: Array<{ key: SidebarTab; icon: typeof MessageSquare; label: string }> = [
  { key: "chat", icon: MessageSquare, label: "Threads" },
  { key: "git", icon: FolderGit2, label: "Changes" }
];

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

/** Convert raw model IDs into human-friendly display names */
function prettifyModelId(raw: string): string {
  // Known exact mappings
  const known: Record<string, string> = {
    "gpt-4": "GPT 4",
    "gpt-4-turbo": "GPT 4 Turbo",
    "gpt-4o": "GPT 4o",
    "gpt-4o-mini": "GPT 4o Mini",
    "gpt-4.1": "GPT 4.1",
    "gpt-4.1-mini": "GPT 4.1 Mini",
    "gpt-4.1-nano": "GPT 4.1 Nano",
    "gpt-4.5-preview": "GPT 4.5 Preview",
    "gpt-5": "GPT 5",
    "gpt-5-mini": "GPT 5 Mini",
    "gpt-5-turbo": "GPT 5 Turbo",
    "gpt-5.2-codex": "GPT 5.2 Codex",
    "gpt-5.3": "GPT 5.3",
    "gpt-5.3-codex": "GPT 5.3 Codex",
    "gpt-5.4": "GPT 5.4",
    "o1": "O1",
    "o1-mini": "O1 Mini",
    "o1-preview": "O1 Preview",
    "o3": "O3",
    "o3-mini": "O3 Mini",
    "o4-mini": "O4 Mini",
    "chatgpt-4o-latest": "ChatGPT 4o Latest",
    "claude-haiku-4.5": "Claude Haiku 4.5",
    "claude-opus-4.5": "Claude Opus 4.5",
    "claude-opus-4.6": "Claude Opus 4.6",
    "claude-sonnet-4": "Claude Sonnet 4",
    "claude-sonnet-4.5": "Claude Sonnet 4.5",
    "claude-sonnet-4.6": "Claude Sonnet 4.6",
    "gemini-3-flash": "Gemini 3 Flash",
    "gemini-3.1-pro-preview": "Gemini 3.1 Pro Preview",
    "gemini-2.5-pro": "Gemini 2.5 Pro",
    "gemini-2.5-flash": "Gemini 2.5 Flash",
    "grok-code-fast-1": "Grok Code Fast 1",
  };

  // Strip date suffixes like -20250514, -2025-04-14
  const stripped = raw.replace(/-\d{4}-?\d{2}-?\d{2}$/, "").replace(/-\d{8}$/, "");
  if (known[stripped]) return known[stripped];
  if (known[raw]) return known[raw];

  // OpenRouter format: provider/model-name
  if (raw.includes("/")) {
    const parts = raw.split("/");
    const modelPart = parts[parts.length - 1] ?? raw;
    return prettifyModelId(modelPart);
  }

  // Claude models
  if (stripped.startsWith("claude-")) {
    return stripped
      .replace("claude-", "Claude ")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/\s+/g, " ")
      .trim();
  }

  // Gemini models
  if (stripped.startsWith("gemini-")) {
    return stripped
      .replace("gemini-", "Gemini ")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/\s+/g, " ")
      .trim();
  }

  // Grok models
  if (stripped.startsWith("grok-")) {
    return stripped
      .replace("grok-", "Grok ")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/\s+/g, " ")
      .trim();
  }

  // Generic: remove dashes, capitalize words
  return stripped
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

function groupFiles(files: FileItem[]) {
  const groups = new Map<string, FileItem[]>();
  for (const file of files) {
    const top = file.path.split("/")[0] ?? file.folder;
    const existing = groups.get(top) ?? [];
    existing.push(file);
    groups.set(top, existing);
  }

  return Array.from(groups.entries()).map(([label, items]) => ({
    label,
    items: items.sort((left, right) => left.path.localeCompare(right.path))
  }));
}

export default function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [activeFileId, setActiveFileId] = useState("");
  const [openFileIds, setOpenFileIds] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [provider, setProvider] = useState(() => localStorage.getItem("ac:provider") || "");
  const [model, setModel] = useState(() => localStorage.getItem("ac:model") || "");
  const [prompt, setPrompt] = useState("");
  const [terminalRuns, setTerminalRuns] = useState<CommandRun[]>([]);
  const [dockTab, setDockTab] = useState<DockTab>("terminal");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("chat");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState(() => localStorage.getItem("ac:sessionId") || "");
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [fsEntries, setFsEntries] = useState<FsEntry[]>([]);
  const [fsPath, setFsPath] = useState("apps");
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState("");
  const [showRightPanel, setShowRightPanel] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const terminalOutputRef = useRef<HTMLPreElement>(null);

  // xterm.js terminal state
  const xtermContainerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const termWsRef = useRef<WebSocket | null>(null);
  const [xtermReady, setXtermReady] = useState(false);

  // Auth state
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [apiKeyVisible, setApiKeyVisible] = useState<Record<string, boolean>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [githubDevice, setGithubDevice] = useState<GitHubDeviceCodeResponse | null>(null);
  const [githubPolling, setGithubPolling] = useState(false);
  const [githubStarting, setGithubStarting] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const githubDeviceRef = useRef<GitHubDeviceCodeResponse | null>(null);
  const githubPollingRef = useRef(false);

  // Streaming state
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const streamingContentRef = useRef("");

  // Tool call tracking during streaming
  const [activeToolCalls, setActiveToolCalls] = useState<Array<{
    toolCallId: string;
    toolName: string;
    arguments?: string;
    result?: string;
    isError?: boolean;
    status: "running" | "done" | "error";
  }>>([]);

  // Tracks whether user explicitly cleared the session (prevents auto-select on next poll)
  const userClearedSessionRef = useRef(false);

  // Overlay state
  const [showSettings, setShowSettings] = useState(false);
  const [showSearchPopup, setShowSearchPopup] = useState(false);
  const searchPopupRef = useRef<HTMLInputElement>(null);

  // Branch switcher state
  const [showBranchSwitcher, setShowBranchSwitcher] = useState(false);
  const [branchData, setBranchData] = useState<{
    current: string;
    local: string[];
    remote: string[];
    hasUncommittedChanges: boolean;
  } | null>(null);
  const [branchFilter, setBranchFilter] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchError, setBranchError] = useState("");
  const branchFilterRef = useRef<HTMLInputElement>(null);

  // Project switcher state
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false);
  const [recentProjects, setRecentProjects] = useState<Array<{ path: string; name: string; lastOpened: number }>>([]);
  const [projectFilter, setProjectFilter] = useState("");
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectError, setProjectError] = useState("");
  const [projectPathInput, setProjectPathInput] = useState("");
  const projectFilterRef = useRef<HTMLInputElement>(null);

  // Model toggles — persisted to localStorage, keyed by raw model ID
  const [disabledModels, setDisabledModels] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("ac:disabledModels") || "{}") as Record<string, boolean>;
    } catch { return {}; }
  });

  // Chat autocomplete state
  const [autocompleteType, setAutocompleteType] = useState<"@" | "/" | null>(null);
  const [autocompleteQuery, setAutocompleteQuery] = useState("");
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);

  // Context window and usage tracking
  const [sessionUsage, setSessionUsage] = useState<{
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    requestCount: number;
  }>({ totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0, requestCount: 0 });

  // Provider-level usage / quota tracking
  const [providerUsage, setProviderUsage] = useState<Array<{
    providerId: string;
    usagePercent: number | null;
    usageLabel: string;
    details: string;
    hasQuota: boolean;
  }>>([]);
  const providerUsageTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
      throw new Error(body?.message ?? body?.error ?? `Request failed: ${response.status}`);
    }
    return (await response.json()) as T;
  }

  /** Fetch provider usage data from server */
  const fetchProviderUsage = useCallback(async () => {
    try {
      const data = await fetch(`${serverUrl}/api/provider-usage`).then((r) => r.json()) as {
        providers: Array<{
          providerId: string;
          usagePercent: number | null;
          usageLabel: string;
          details: string;
          hasQuota: boolean;
        }>;
      };
      setProviderUsage(data.providers);
    } catch {
      // Silently ignore — usage display is best-effort
    }
  }, []);

  // Poll provider usage on mount and every 60 seconds
  useEffect(() => {
    fetchProviderUsage();
    providerUsageTimerRef.current = setInterval(fetchProviderUsage, 60_000);
    return () => {
      if (providerUsageTimerRef.current) clearInterval(providerUsageTimerRef.current);
    };
  }, [fetchProviderUsage]);

  /** Connect to SSE stream for a session. Call this after sending a message. */
  const connectStream = useCallback((sessionId: string) => {
    // Close any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    streamingContentRef.current = "";
    setStreamingContent("");
    setStreamingMessageId(null);
    setActiveToolCalls([]);

    const es = new EventSource(`${serverUrl}/api/sessions/${sessionId}/stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type: "connected" | "token" | "done" | "error" | "tool_call" | "tool_result";
          messageId?: string;
          token?: string;
          error?: string;
          usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
          toolCallId?: string;
          toolName?: string;
          arguments?: string;
          result?: string;
          isError?: boolean;
        };

        if (data.type === "token" && data.token) {
          if (data.messageId && !streamingContentRef.current) {
            setStreamingMessageId(data.messageId);
          }
          streamingContentRef.current += data.token;
          setStreamingContent(streamingContentRef.current);
        } else if (data.type === "tool_call" && data.toolCallId) {
          // A new tool call is starting — add it to the active list
          setActiveToolCalls((prev) => [
            ...prev,
            {
              toolCallId: data.toolCallId!,
              toolName: data.toolName || "unknown",
              arguments: data.arguments,
              status: "running"
            }
          ]);
          // Clear streaming content since the AI text portion for this round is done
          // and we're now in tool execution phase
          streamingContentRef.current = "";
          setStreamingContent("");
        } else if (data.type === "tool_result" && data.toolCallId) {
          // A tool call completed — update its status and result
          setActiveToolCalls((prev) =>
            prev.map((tc) =>
              tc.toolCallId === data.toolCallId
                ? { ...tc, result: data.result, isError: data.isError, status: data.isError ? "error" : "done" }
                : tc
            )
          );
        } else if (data.type === "done") {
          // Accumulate usage data if present
          if (data.usage) {
            setSessionUsage((prev) => ({
              totalInputTokens: prev.totalInputTokens + data.usage!.inputTokens,
              totalOutputTokens: prev.totalOutputTokens + data.usage!.outputTokens,
              totalTokens: prev.totalTokens + data.usage!.totalTokens,
              requestCount: prev.requestCount + 1,
            }));
          } else {
            // Even without usage data, increment request count
            setSessionUsage((prev) => ({ ...prev, requestCount: prev.requestCount + 1 }));
          }
          // Stream complete — reload session to get final message from server
          setStreamingContent("");
          setStreamingMessageId(null);
          streamingContentRef.current = "";
          setActiveToolCalls([]);
          // Fetch the final session state
          fetchJson<SessionDetail>(`${serverUrl}/api/sessions/${sessionId}`)
            .then((payload) => setSessionDetail(payload))
            .catch(() => undefined);
          // Refresh provider usage (rate limit headers may have updated)
          fetchProviderUsage();
          es.close();
          eventSourceRef.current = null;
        } else if (data.type === "error") {
          // Error — reload session and close
          setStreamingContent("");
          setStreamingMessageId(null);
          streamingContentRef.current = "";
          setActiveToolCalls([]);
          fetchJson<SessionDetail>(`${serverUrl}/api/sessions/${sessionId}`)
            .then((payload) => setSessionDetail(payload))
            .catch(() => undefined);
          es.close();
          eventSourceRef.current = null;
        }
      } catch {
        // Ignore malformed messages
      }
    };

    es.onerror = () => {
      // Reconnection is handled by EventSource automatically, but if the
      // stream was intentionally closed we just ignore
    };
  }, [fetchProviderUsage]);

  // Whether AI is currently streaming a response
  const isStreaming = !!(streamingContent || eventSourceRef.current);

  /** Stop an in-flight AI streaming response */
  async function handleStopStreaming() {
    // Close client-side SSE connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setStreamingContent("");
    setStreamingMessageId(null);
    streamingContentRef.current = "";
    setActiveToolCalls([]);

    // Tell server to abort the underlying fetch
    if (activeSessionId) {
      try {
        await fetch(`${serverUrl}/api/sessions/${activeSessionId}/abort`, { method: "POST" });
        // Reload session to get any partial content saved
        const payload = await fetchJson<SessionDetail>(`${serverUrl}/api/sessions/${activeSessionId}`);
        setSessionDetail(payload);
      } catch {
        // Ignore — best effort
      }
    }
  }

  // Cleanup EventSources on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      // Cleanup xterm
      if (termWsRef.current) {
        termWsRef.current.close();
        termWsRef.current = null;
      }
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
      }
    };
  }, []);

  // xterm.js initialization — creates terminal + WebSocket connection when panel is shown
  useEffect(() => {
    if (!showTerminal) return;
    // Wait for the container to be mounted
    const container = xtermContainerRef.current;
    if (!container) return;
    // If already initialized, just re-fit
    if (xtermRef.current) {
      requestAnimationFrame(() => fitAddonRef.current?.fit());
      return;
    }

    const term = new XTerminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'IBM Plex Mono', 'Menlo', 'Monaco', monospace",
      lineHeight: 1.4,
      theme: {
        background: "#101010",
        foreground: "rgba(255, 255, 255, 0.85)",
        cursor: "#fab283",
        selectionBackground: "rgba(255, 255, 255, 0.15)",
        black: "#1c1c1c",
        red: "#fc533a",
        green: "#12c905",
        yellow: "#fab283",
        blue: "#034cff",
        magenta: "#c678dd",
        cyan: "#56b6c2",
        white: "rgba(255, 255, 255, 0.85)",
        brightBlack: "#5c6370",
        brightRed: "#e06c75",
        brightGreen: "#98c379",
        brightYellow: "#e5c07b",
        brightBlue: "#61afef",
        brightMagenta: "#c678dd",
        brightCyan: "#56b6c2",
        brightWhite: "#ffffff"
      }
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      if (window.alphaCode?.openExternal) {
        window.alphaCode.openExternal(uri);
      } else {
        window.open(uri, "_blank", "noopener,noreferrer");
      }
    });
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(container);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Connect to WebSocket PTY server
    const ws = new WebSocket(wsUrl);
    termWsRef.current = ws;

    ws.onopen = () => {
      setXtermReady(true);
      console.log("[terminal] WebSocket connected");
      // Send initial size
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          data?: string;
          exitCode?: number;
          signal?: number;
        };
        if (msg.type === "output" && msg.data) {
          term.write(msg.data);
        } else if (msg.type === "exit") {
          term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
        }
      } catch {
        // Ignore malformed
      }
    };

    ws.onclose = () => {
      setXtermReady(false);
      console.log("[terminal] WebSocket disconnected");
    };

    ws.onerror = () => {
      setXtermReady(false);
    };

    // User input → WebSocket → PTY
    const inputDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    // Handle resize
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    // Re-fit on window resize
    const handleWindowResize = () => fitAddon.fit();
    window.addEventListener("resize", handleWindowResize);

    // Also observe the container for size changes (panel resizing)
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => fitAddon.fit());
    });
    resizeObserver.observe(container);

    return () => {
      inputDisposable.dispose();
      resizeDisposable.dispose();
      window.removeEventListener("resize", handleWindowResize);
      resizeObserver.disconnect();
      ws.close();
      termWsRef.current = null;
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      setXtermReady(false);
    };
  }, [showTerminal]);

  // Re-fit terminal when switching back to the terminal dock tab
  useEffect(() => {
    if (dockTab === "terminal" && xtermRef.current && fitAddonRef.current) {
      requestAnimationFrame(() => fitAddonRef.current?.fit());
    }
  }, [dockTab]);

  // Persist key state to localStorage
  useEffect(() => { localStorage.setItem("ac:sessionId", activeSessionId); }, [activeSessionId]);
  useEffect(() => { localStorage.setItem("ac:provider", provider); }, [provider]);
  useEffect(() => { localStorage.setItem("ac:model", model); }, [model]);
  useEffect(() => { localStorage.setItem("ac:disabledModels", JSON.stringify(disabledModels)); }, [disabledModels]);

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Cmd+K — open search popup
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowSearchPopup(true);
        requestAnimationFrame(() => {
          searchPopupRef.current?.focus();
        });
      }
      // Cmd+N — new session
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        handleNewSession();
      }
      // Cmd+S — save active file
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void handleSaveFile();
      }
      // Escape — close overlays / clear error
      if (e.key === "Escape") {
        if (showProjectSwitcher) { setShowProjectSwitcher(false); setProjectFilter(""); setProjectPathInput(""); }
        else if (showBranchSwitcher) { setShowBranchSwitcher(false); setBranchFilter(""); setNewBranchName(""); }
        else if (showSearchPopup) { setShowSearchPopup(false); setSearchQuery(""); }
        else if (showSettings) setShowSettings(false);
        else if (error) setError("");
      }
      // Cmd+, — open settings
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setShowSettings((v) => !v);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [error, showSearchPopup, showSettings, showBranchSwitcher, showProjectSwitcher]);

  async function loadWorkspace() {
    const payload = await fetchJson<WorkspaceSnapshot>(`${serverUrl}/api/workspace`);
    setSnapshot(payload);
    setTerminalRuns(payload.recentRuns);
    setDrafts((current) => {
      const next = { ...current };
      for (const file of payload.workspace.files) {
        if (!(file.id in next)) {
          next[file.id] = file.content;
        }
      }
      return next;
    });

    if (!activeFileId && payload.workspace.files[0]) {
      setActiveFileId(payload.workspace.files[0].id);
      setOpenFileIds([payload.workspace.files[0].id]);
    }

    if (!activeSessionId && payload.sessions[0] && !userClearedSessionRef.current) {
      setActiveSessionId(payload.sessions[0].id);
    }

    if (payload.providers[0]) {
      setProvider((current) => current || payload.providers[0]!.label);
      setModel((current) => current || payload.providers[0]!.model);
    }

    setExpandedGroups((current) => {
      if (Object.keys(current).length > 0) {
        return current;
      }
      return Object.fromEntries(groupFiles(payload.workspace.files).map((group) => [group.label, true]));
    });
  }

  async function loadSession(sessionId: string) {
    if (!sessionId) {
      setSessionDetail(null);
      return;
    }

    const payload = await fetchJson<SessionDetail>(`${serverUrl}/api/sessions/${sessionId}`);
    setSessionDetail(payload);
    setTerminalRuns((current) => {
      const merged = [...payload.commandRuns, ...current.filter((item) => !payload.commandRuns.some((run) => run.id === item.id))];
      return merged.slice(0, 12);
    });
  }

  async function loadFs(pathValue: string) {
    const payload = await fetchJson<{ path: string; children: FsEntry[] }>(
      `${serverUrl}/api/fs?path=${encodeURIComponent(pathValue)}`
    );
    setFsPath(payload.path);
    setFsEntries(payload.children.sort((left, right) => left.path.localeCompare(right.path)));
  }

  async function loadAuthStatus() {
    try {
      const payload = await fetchJson<AuthStatusResponse>(`${serverUrl}/api/auth/status`);
      setAuthStatus(payload);
    } catch {
      // Silently fail — auth status is non-critical
    }
  }

  async function saveApiKey(providerId: ProviderId, key: string) {
    setSavingKey(providerId);
    try {
      await fetchJson(`${serverUrl}/api/auth/keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: providerId, key })
      });
      setApiKeyInputs((current) => ({ ...current, [providerId]: "" }));
      await loadAuthStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save key");
    } finally {
      setSavingKey(null);
    }
  }

  async function removeApiKey(providerId: string) {
    setRemovingKey(providerId);
    try {
      await fetchJson(`${serverUrl}/api/auth/keys/${providerId}`, { method: "DELETE" });
      await loadAuthStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove key");
    } finally {
      setRemovingKey(null);
    }
  }

  async function startGitHubLogin() {
    setGithubStarting(true);
    try {
      const payload = await fetchJson<GitHubDeviceCodeResponse>(`${serverUrl}/api/auth/github/start`, {
        method: "POST"
      });
      setGithubDevice(payload);
      setGithubPolling(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start GitHub login");
    } finally {
      setGithubStarting(false);
    }
  }

  function copyToClipboard(text: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    });
  }

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        setLoading(true);
        setError("");
        await Promise.all([loadWorkspace(), loadFs("apps"), loadAuthStatus()]);
      } catch (nextError) {
        if (active) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load workspace");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void bootstrap();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      setSessionDetail(null);
      return;
    }

    void loadSession(activeSessionId).catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : "Failed to load session");
    });
  }, [activeSessionId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadWorkspace().catch(() => undefined);
      // Only poll session detail when NOT actively streaming (SSE handles that)
      if (activeSessionId && !eventSourceRef.current) {
        void loadSession(activeSessionId).catch(() => undefined);
      }
    }, 2500);

    return () => window.clearInterval(timer);
  }, [activeSessionId]);

  // Auto-dismiss error toast after 6 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(""), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  // Auto-scroll to bottom on new messages or streaming content
  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [sessionDetail?.messages.length, streamingContent]);

  // GitHub OAuth polling — uses setTimeout chain (not setInterval) to respect dynamic intervals
  const pollIntervalRef = useRef(5000);

  // Keep refs in sync for use inside async poll closures
  useEffect(() => { githubDeviceRef.current = githubDevice; }, [githubDevice]);
  useEffect(() => { githubPollingRef.current = githubPolling; }, [githubPolling]);

  useEffect(() => {
    if (!githubPolling || !githubDevice) return;

    // Reset interval at the start of a new device flow
    pollIntervalRef.current = Math.max((githubDevice.interval || 5) * 1000, 5000);
    let cancelled = false;

    async function poll() {
      const device = githubDeviceRef.current;
      if (cancelled || !device || !githubPollingRef.current) return;

      try {
        const result = await fetchJson<GitHubPollResponse>(
          `${serverUrl}/api/auth/github/poll?device_code=${encodeURIComponent(device.deviceCode)}`
        );
        if (cancelled) return;

        if (result.status === "completed") {
          setGithubPolling(false);
          setGithubDevice(null);
          await loadAuthStatus();
          return;
        }

        if (result.status === "expired" || result.status === "error") {
          setGithubPolling(false);
          setGithubDevice(null);
          if (result.error) setError(result.error);
          return;
        }

        // pending — schedule next poll, respecting any new interval from slow_down
        if (result.interval) {
          pollIntervalRef.current = result.interval * 1000;
        }
      } catch {
        // Network error — continue polling with a longer backoff
        pollIntervalRef.current = Math.min(pollIntervalRef.current + 2000, 60000);
      }

      if (!cancelled) {
        setTimeout(poll, pollIntervalRef.current);
      }
    }

    // First poll after initial interval
    const initialTimer = setTimeout(poll, pollIntervalRef.current);

    return () => {
      cancelled = true;
      clearTimeout(initialTimer);
    };
  }, [githubPolling, githubDevice]);

  const files = snapshot?.workspace.files ?? [];
  const activeFile = files.find((file) => file.id === activeFileId) ?? files[0] ?? null;
  const openFiles = openFileIds
    .map((fileId) => files.find((file) => file.id === fileId))
    .filter((file): file is FileItem => Boolean(file));
  const groupedFiles = useMemo(() => groupFiles(files), [files]);
  const changedFiles = useMemo(
    () => files.filter((file) => (drafts[file.id] ?? file.content) !== file.content),
    [drafts, files]
  );
  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) {
      return files;
    }
    const query = searchQuery.toLowerCase();
    return files.filter((file) => file.path.toLowerCase().includes(query) || file.content.toLowerCase().includes(query));
  }, [files, searchQuery]);
  // Merge terminal runs — prefer terminalRuns (has real-time streaming data) over session commandRuns
  const previewRuns = useMemo(() => {
    const sessionRuns = sessionDetail?.commandRuns ?? [];
    // Merge: use terminalRuns as base, overlay any session-only runs
    const merged = [...terminalRuns];
    for (const sr of sessionRuns) {
      if (!merged.some((r) => r.id === sr.id)) {
        merged.push(sr);
      }
    }
    return merged.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 12);
  }, [terminalRuns, sessionDetail?.commandRuns]);
  const activeRun = previewRuns[0] ?? null;

  // Auto-scroll terminal output
  useEffect(() => {
    if (terminalOutputRef.current) {
      terminalOutputRef.current.scrollTop = terminalOutputRef.current.scrollHeight;
    }
  }, [activeRun?.output]);

  function openFile(fileId: string) {
    setOpenFileIds((current) => (current.includes(fileId) ? current : [...current, fileId]));
    setActiveFileId(fileId);
    setShowRightPanel(true);
  }

  function closeFile(fileId: string) {
    const nextOpenFileIds = openFileIds.filter((item) => item !== fileId);
    setOpenFileIds(nextOpenFileIds);
    if (activeFileId === fileId) {
      setActiveFileId(nextOpenFileIds[0] ?? files[0]?.id ?? "");
    }
  }

  async function handleSaveFile() {
    if (!activeFile) {
      return;
    }
    setSaving(true);
    setError("");
    try {
      await fetchJson(`${serverUrl}/api/file`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: activeFile.path,
          content: drafts[activeFile.id] ?? activeFile.content
        })
      });
      await loadWorkspace();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save file");
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmitPrompt(nextPrompt?: string) {
    const content = (nextPrompt ?? prompt).trim();
    if (!content) {
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      if (!activeSessionId) {
        const payload = await fetchJson<SessionDetail & { streamMessageId?: string }>(`${serverUrl}/api/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: content,
            provider,
            model,
            filePath: activeFile?.path
          })
        });
        setActiveSessionId(payload.id);
        setSessionDetail(payload);
        userClearedSessionRef.current = false;
        // Reset usage tracking for new session
        setSessionUsage({ totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0, requestCount: 0 });
        // Connect to SSE stream for real-time token delivery
        connectStream(payload.id);
      } else {
        const payload = await fetchJson<SessionDetail & { streamMessageId?: string }>(`${serverUrl}/api/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: activeSessionId,
            prompt: content,
            provider,
            model,
            filePath: activeFile?.path
          })
        });
        setSessionDetail(payload);
        // Connect to SSE stream for real-time token delivery
        connectStream(activeSessionId);
      }

      setPrompt("");
      await loadWorkspace();
      setSidebarTab("chat");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to send message");
    } finally {
      setSubmitting(false);
    }
  }

  function handleNewSession() {
    userClearedSessionRef.current = true;
    setActiveSessionId("");
    setSessionDetail(null);
    setPrompt("");
    setSessionUsage({ totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0, requestCount: 0 });
  }

  async function handleDeleteSession(sessionId: string) {
    try {
      await fetchJson(`${serverUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
      if (activeSessionId === sessionId) {
        setActiveSessionId("");
        setSessionDetail(null);
      }
      await loadWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete session");
    }
  }

  async function openBranchSwitcher() {
    setShowBranchSwitcher(true);
    setBranchFilter("");
    setNewBranchName("");
    setBranchError("");
    setBranchLoading(true);
    try {
      const data = await fetchJson<{
        current: string;
        local: string[];
        remote: string[];
        hasUncommittedChanges: boolean;
      }>(`${serverUrl}/api/git/branches`);
      setBranchData(data);
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : "Failed to load branches");
    } finally {
      setBranchLoading(false);
      requestAnimationFrame(() => branchFilterRef.current?.focus());
    }
  }

  async function handleCheckoutBranch(branch: string) {
    if (branch === branchData?.current) return;
    setBranchLoading(true);
    setBranchError("");
    try {
      await fetchJson<{ branch: string }>(`${serverUrl}/api/git/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch }),
      });
      setShowBranchSwitcher(false);
      await loadWorkspace();
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : "Checkout failed");
    } finally {
      setBranchLoading(false);
    }
  }

  async function handleCreateBranch() {
    if (!newBranchName.trim()) return;
    setBranchLoading(true);
    setBranchError("");
    try {
      await fetchJson<{ branch: string; created: string }>(`${serverUrl}/api/git/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newBranchName.trim(), checkout: true }),
      });
      setShowBranchSwitcher(false);
      setNewBranchName("");
      await loadWorkspace();
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : "Branch creation failed");
    } finally {
      setBranchLoading(false);
    }
  }

  /* ---- Project Switcher ---- */

  async function openProjectSwitcher() {
    setShowProjectSwitcher(true);
    setProjectFilter("");
    setProjectPathInput("");
    setProjectError("");
    setProjectLoading(true);
    try {
      const data = await fetchJson<{
        projects: Array<{ path: string; name: string; lastOpened: number }>;
      }>(`${serverUrl}/api/workspace/recent`);
      setRecentProjects(data.projects);
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setProjectLoading(false);
      requestAnimationFrame(() => projectFilterRef.current?.focus());
    }
  }

  async function handleSwitchProject(projectPath: string) {
    if (projectPath === snapshot?.workspace?.root) return;
    setProjectLoading(true);
    setProjectError("");
    try {
      await fetchJson<{ root: string; name: string }>(`${serverUrl}/api/workspace/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: projectPath }),
      });
      setShowProjectSwitcher(false);

      // --- Close any active SSE stream to the old session ---
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      streamingContentRef.current = "";

      // Reset editor state for the new project
      setActiveFileId("");
      setOpenFileIds([]);
      setDrafts({});
      setExpandedGroups({});
      setFsEntries([]);
      setFsPath("");
      setSearchQuery("");

      // Clear session state — old sessions belong to the previous project
      setActiveSessionId("");
      setSessionDetail(null);
      setStreamingContent("");
      setStreamingMessageId(null);
      setActiveToolCalls([]);

      // Clear chat input & submission state
      setPrompt("");
      setSubmitting(false);
      setError("");

      // Clear terminal runs (will be repopulated by loadWorkspace)
      setTerminalRuns([]);

      // Reset usage tracking for the new project
      setSessionUsage({ totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0, requestCount: 0 });

      // Close autocomplete if open
      setAutocompleteType(null);
      setAutocompleteQuery("");
      setAutocompleteIndex(0);

      userClearedSessionRef.current = true;
      await loadWorkspace();
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : "Switch failed");
    } finally {
      setProjectLoading(false);
    }
  }

  async function handleOpenProjectPath() {
    const p = projectPathInput.trim();
    if (!p) return;
    await handleSwitchProject(p);
  }

  async function handlePickFolder() {
    if (electronBridge?.pickFolder) {
      const picked = await electronBridge.pickFolder();
      if (picked) {
        await handleSwitchProject(picked);
      }
    }
  }

  if (loading) {
    return (
      <main className="loading-shell">
        <div className="loading-mark">
          <span className="logo-block" />
          <strong>{APP_NAME}</strong>
        </div>
      </main>
    );
  }

  if (error && !snapshot) {
    return (
      <main className="loading-shell">
        <div className="error-block">
          <strong>{APP_NAME}</strong>
          <p>{error}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      {/* ===== Titlebar ===== */}
      <header className={`titlebar${isElectron ? " electron" : ""}${isMac ? " mac" : ""}`}>
        <div className="titlebar-side left">
          <span className="brand-lockup">{APP_NAME}</span>
          <button className="titlebar-chip muted" type="button" title="Open project folder" onClick={openProjectSwitcher}>
            <FolderGit2 size={12} />
            <span>{snapshot?.workspace.name}</span>
          </button>
          <button className="titlebar-chip muted" type="button" title="Switch branch" onClick={openBranchSwitcher}>
            <GitBranch size={12} />
            <span>{snapshot?.workspace?.branch ?? "main"}</span>
          </button>
        </div>

        <div className="titlebar-center">
          <button className="command-palette" type="button" onClick={() => { setShowSearchPopup(true); requestAnimationFrame(() => searchPopupRef.current?.focus()); }}>
            <Search size={13} />
            <span>Search files, sessions, commands</span>
            <kbd>Cmd K</kbd>
          </button>
        </div>

        <div className="titlebar-side right">
          <button
            className={`toggle-panel-btn${showTerminal ? " active" : ""}`}
            type="button"
            onClick={() => setShowTerminal((v) => !v)}
            title="Toggle terminal"
          >
            <Terminal size={12} />
          </button>
          <button
            className={`toggle-panel-btn${showRightPanel ? " active" : ""}`}
            type="button"
            onClick={() => setShowRightPanel((v) => !v)}
            title="Toggle editor panel"
          >
            <PanelRight size={12} />
          </button>

          {/* Custom window controls for Windows/Linux Electron (frameless) */}
          {isElectron && !isMac && (
            <div className="window-controls">
              <button
                className="window-control-btn"
                type="button"
                onClick={() => electronBridge!.windowControl("minimize")}
                title="Minimize"
              >
                <Minus size={14} />
              </button>
              <button
                className="window-control-btn"
                type="button"
                onClick={() => electronBridge!.windowControl("maximize")}
                title="Maximize"
              >
                <Maximize2 size={12} />
              </button>
              <button
                className="window-control-btn close"
                type="button"
                onClick={() => electronBridge!.windowControl("close")}
                title="Close"
              >
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ===== Body: sidebar + main ===== */}
      <div className="workspace">
        {/* Left sidebar */}
        <div className="sidebar-layout">
          <aside className="sidebar-rail">
            {railItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  className={`rail-button${sidebarTab === item.key ? " active" : ""}`}
                  type="button"
                  title={item.label}
                  onClick={() => setSidebarTab(item.key)}
                >
                  <Icon size={16} />
                </button>
              );
            })}
            <div className="rail-spacer" />
            <button
              className={`rail-button${showSettings ? " active" : ""}`}
              type="button"
              title="Settings"
              onClick={() => setShowSettings((v) => !v)}
            >
              <Settings2 size={16} />
            </button>
          </aside>

          <section className="sidebar-panel">
            {sidebarTab === "chat" ? (
              <>
                <div className="pane-header">
                  <div>
                    <span className="pane-kicker">Threads</span>
                    <h2>Sessions</h2>
                  </div>
                  <button className="pane-button accent" type="button" onClick={handleNewSession}>
                    <Sparkles size={12} />
                    <span>New</span>
                  </button>
                </div>

                <div className="session-list compact-scroll">
                  {(snapshot?.sessions ?? []).length === 0 ? (
                    <div className="empty-inline">No sessions yet</div>
                  ) : (
                    snapshot?.sessions.map((session) => (
                      <div
                        key={session.id}
                        className={`session-row${activeSessionId === session.id ? " active" : ""}`}
                      >
                        <button
                          className="session-row-main"
                          type="button"
                          onClick={() => { userClearedSessionRef.current = false; setActiveSessionId(session.id); }}
                        >
                          <span className={`session-status ${session.status}`} />
                          <span className="session-copy">
                            <strong>{session.title}</strong>
                            <small>
                              {session.provider} · {formatTime(session.updatedAt)}
                            </small>
                          </span>
                        </button>
                        <button
                          className="session-delete-btn"
                          type="button"
                          title="Delete session"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDeleteSession(session.id);
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <div className="sidebar-footer-note">
                  <span>Recent runs</span>
                  <strong>{terminalRuns.length}</strong>
                </div>
              </>
            ) : null}

            {sidebarTab === "git" ? (
              <>
                <div className="pane-header">
                  <div>
                    <span className="pane-kicker">Review</span>
                    <h2>Changes</h2>
                  </div>
                </div>
                <div className="change-list compact-scroll">
                  {changedFiles.length === 0 ? (
                    <div className="empty-inline">No unsaved changes</div>
                  ) : (
                    changedFiles.map((file) => (
                      <button key={file.id} className="change-card" type="button" onClick={() => openFile(file.id)}>
                        <FileDiff size={13} />
                        <span>{file.path}</span>
                      </button>
                    ))
                  )}
                </div>
              </>
            ) : null}
          </section>
        </div>

        {/* Main content area */}
        <PanelGroup direction="horizontal" autoSaveId="alpha-code-main">
          {/* Session column */}
          <Panel minSize={36}>
            <PanelGroup direction="vertical" autoSaveId="alpha-code-vert">
              {/* Session view */}
              <Panel minSize={30}>
                <div className="session-view">
                  {/* Message timeline */}
                  <div className="message-timeline compact-scroll">
                    {sessionDetail ? (
                      <>
                        {sessionDetail.messages.map((message, msgIdx) => {
                          // Skip tool-result messages — they are rendered inline within their parent assistant message
                          if (message.role === "tool") return null;

                          // For assistant messages with toolCalls, find the matching tool result messages
                          const toolResults: Record<string, { result: string; isError?: boolean }> = {};
                          if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
                            // Look ahead in messages for tool results
                            for (let i = msgIdx + 1; i < sessionDetail.messages.length; i++) {
                              const m = sessionDetail.messages[i];
                              if (m.role === "tool" && m.toolCallId) {
                                toolResults[m.toolCallId] = { result: m.content, isError: m.isError };
                              } else if (m.role !== "tool") {
                                break; // Stop once we hit a non-tool message
                              }
                            }
                          }

                          return (
                            <article key={message.id} className={`message-turn ${message.role}`}>
                              <div className="message-meta">
                                <span>{message.role}</span>
                                <span>{formatTime(message.createdAt)}</span>
                                <div className="message-actions">
                                  <button
                                    className="message-action-btn"
                                    type="button"
                                    title="Copy message"
                                    onClick={() => {
                                      void navigator.clipboard.writeText(message.content);
                                    }}
                                  >
                                    <Copy size={12} />
                                  </button>
                                  <button
                                    className="message-action-btn"
                                    type="button"
                                    title="Delete message"
                                    onClick={async () => {
                                      try {
                                        await fetch(`${serverUrl}/api/messages/${message.id}`, { method: "DELETE" });
                                        if (activeSessionId) {
                                          const payload = await fetchJson<SessionDetail>(`${serverUrl}/api/sessions/${activeSessionId}`);
                                          setSessionDetail(payload);
                                        }
                                      } catch {
                                        // Ignore
                                      }
                                    }}
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              </div>
                              {/* Message text content */}
                              {message.content && (
                                <div className="message-content">
                                  {message.role === "assistant" ? (
                                    <ReactMarkdown
                                      remarkPlugins={[remarkGfm]}
                                      rehypePlugins={[rehypeHighlight]}
                                      components={{
                                        pre({ children, ...props }) {
                                          return (
                                            <div className="md-code-block">
                                              <button
                                                className="md-code-copy"
                                                onClick={(e) => {
                                                  const code = (e.currentTarget.parentElement?.querySelector("code") as HTMLElement | null)?.innerText ?? "";
                                                  navigator.clipboard.writeText(code);
                                                  const btn = e.currentTarget;
                                                  btn.textContent = "Copied!";
                                                  setTimeout(() => { btn.textContent = "Copy"; }, 1500);
                                                }}
                                              >Copy</button>
                                              <pre {...props}>{children}</pre>
                                            </div>
                                          );
                                        },
                                      }}
                                    >{message.content}</ReactMarkdown>
                                  ) : (
                                    <pre>{message.content}</pre>
                                  )}
                                </div>
                              )}
                              {/* Tool call blocks — shown on assistant messages that invoked tools */}
                              {message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0 && (
                                <div className="tool-calls-container">
                                  {message.toolCalls.map((tc) => {
                                    const tr = toolResults[tc.id];
                                    let parsedArgs: Record<string, unknown> = {};
                                    try { parsedArgs = JSON.parse(tc.arguments) as Record<string, unknown>; } catch { /* ignore */ }
                                    const toolLabel = tc.name === "run_command" ? `$ ${(parsedArgs.command as string) || tc.name}`
                                      : tc.name === "read_file" ? `Read ${(parsedArgs.filePath as string) || ""}`
                                      : tc.name === "write_file" ? `Write ${(parsedArgs.filePath as string) || ""}`
                                      : tc.name === "list_files" ? `List ${(parsedArgs.dirPath as string) || "."}`
                                      : tc.name;
                                    return (
                                      <details key={tc.id} className={`tool-call-block ${tr?.isError ? "error" : "done"}`}>
                                        <summary className="tool-call-header">
                                          <Wrench size={13} />
                                          <span className="tool-call-name">{toolLabel}</span>
                                          {tr?.isError ? (
                                            <span className="tool-call-status error"><CircleAlert size={11} /> error</span>
                                          ) : (
                                            <span className="tool-call-status done"><Check size={11} /> done</span>
                                          )}
                                        </summary>
                                        {tr && (
                                          <pre className="tool-call-output">{tr.result}</pre>
                                        )}
                                      </details>
                                    );
                                  })}
                                </div>
                              )}
                            </article>
                          );
                        })}

                        {/* Active tool calls — shown during streaming when tools are executing */}
                        {activeToolCalls.length > 0 && (
                          <div className="tool-calls-container streaming">
                            {activeToolCalls.map((tc) => {
                              let parsedArgs: Record<string, unknown> = {};
                              try { parsedArgs = JSON.parse(tc.arguments || "{}") as Record<string, unknown>; } catch { /* ignore */ }
                              const toolLabel = tc.toolName === "run_command" ? `$ ${(parsedArgs.command as string) || tc.toolName}`
                                : tc.toolName === "read_file" ? `Read ${(parsedArgs.filePath as string) || ""}`
                                : tc.toolName === "write_file" ? `Write ${(parsedArgs.filePath as string) || ""}`
                                : tc.toolName === "list_files" ? `List ${(parsedArgs.dirPath as string) || "."}`
                                : tc.toolName;
                              return (
                                <details key={tc.toolCallId} className={`tool-call-block ${tc.status}`} open={tc.status === "running"}>
                                  <summary className="tool-call-header">
                                    {tc.status === "running" ? <LoaderCircle size={13} className="spin" /> : <Wrench size={13} />}
                                    <span className="tool-call-name">{toolLabel}</span>
                                    {tc.status === "running" && (
                                      <span className="tool-call-status running">running</span>
                                    )}
                                    {tc.status === "done" && (
                                      <span className="tool-call-status done"><Check size={11} /> done</span>
                                    )}
                                    {tc.status === "error" && (
                                      <span className="tool-call-status error"><CircleAlert size={11} /> error</span>
                                    )}
                                  </summary>
                                  {tc.result && (
                                    <pre className="tool-call-output">{tc.result}</pre>
                                  )}
                                </details>
                              );
                            })}
                          </div>
                        )}

                        {/* Streaming assistant message — shown while tokens arrive */}
                        {streamingContent && (
                          <article className="message-turn assistant streaming">
                            <div className="message-meta">
                              <span>assistant</span>
                              <span className="streaming-indicator">streaming</span>
                            </div>
                            <div className="message-content">
                              <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                rehypePlugins={[rehypeHighlight]}
                                components={{
                                  pre({ children, ...props }) {
                                    return (
                                      <div className="md-code-block">
                                        <button
                                          className="md-code-copy"
                                          onClick={(e) => {
                                            const code = (e.currentTarget.parentElement?.querySelector("code") as HTMLElement | null)?.innerText ?? "";
                                            navigator.clipboard.writeText(code);
                                            const btn = e.currentTarget;
                                            btn.textContent = "Copied!";
                                            setTimeout(() => { btn.textContent = "Copy"; }, 1500);
                                          }}
                                        >Copy</button>
                                        <pre {...props}>{children}</pre>
                                      </div>
                                    );
                                  },
                                }}
                              >{streamingContent}</ReactMarkdown>
                            </div>
                          </article>
                        )}
                        <div ref={messageEndRef} />
                      </>
                    ) : (
                      <div className="empty-state">
                        <div className="welcome-hero">
                          <Sparkles size={28} className="welcome-icon" />
                          <h2 className="welcome-title">Alpha Code</h2>
                          <p className="welcome-subtitle">AI-powered code editor. Ask questions, run commands, and edit files — all in one place.</p>
                        </div>
                        <div className="welcome-actions">
                          <button className="welcome-card" type="button" onClick={handleNewSession}>
                            <Plus size={16} />
                            <div>
                              <strong>New Session</strong>
                              <span>Start a conversation with AI</span>
                            </div>
                          </button>
                          <button className="welcome-card" type="button" onClick={() => { setShowTerminal(true); setDockTab("terminal"); }}>
                            <Terminal size={16} />
                            <div>
                              <strong>Open Terminal</strong>
                              <span>Run commands in your project</span>
                            </div>
                          </button>
                          <button className="welcome-card" type="button" onClick={() => setShowRightPanel(true)}>
                            <Files size={16} />
                            <div>
                              <strong>Browse Files</strong>
                              <span>Explore your project tree</span>
                            </div>
                          </button>
                          <button className="welcome-card" type="button" onClick={() => setShowSettings(true)}>
                            <Settings2 size={16} />
                            <div>
                              <strong>Settings</strong>
                              <span>Configure AI providers</span>
                            </div>
                          </button>
                        </div>
                        <div className="welcome-shortcuts">
                          <span><kbd>{"\u2318"}K</kbd> Search</span>
                          <span><kbd>{"\u2318"}N</kbd> New Session</span>
                          <span><kbd>{"\u2318"}S</kbd> Save File</span>
                          <span><kbd>{"\u21A9"}</kbd> Send Message</span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Suggestions */}
                  {(snapshot?.suggestions ?? []).length > 0 ? (
                    <div className="suggestion-strip">
                      {(snapshot?.suggestions ?? []).map((suggestion) => (
                        <button
                          key={suggestion.id}
                          className="suggestion-chip"
                          type="button"
                          onClick={() => void handleSubmitPrompt(suggestion.label)}
                        >
                          {suggestion.label}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {/* Quick-action chips — shown after assistant response or when no messages */}
                  {!isStreaming && sessionDetail && sessionDetail.messages.length > 0 && sessionDetail.messages[sessionDetail.messages.length - 1]?.role === "assistant" ? (
                    <div className="suggestion-chips">
                      <button className="suggestion-chip-btn" type="button" onClick={() => setPrompt("Explain what this code does")}>
                        Explain this
                      </button>
                      <button className="suggestion-chip-btn" type="button" onClick={() => setPrompt("Find and fix any bugs")}>
                        Fix bugs
                      </button>
                      <button className="suggestion-chip-btn" type="button" onClick={() => setPrompt("Add error handling")}>
                        Add error handling
                      </button>
                      <button className="suggestion-chip-btn" type="button" onClick={() => setPrompt("Write tests for this")}>
                        Write tests
                      </button>
                      <button className="suggestion-chip-btn" type="button" onClick={() => setPrompt("Refactor for better readability")}>
                        Refactor
                      </button>
                    </div>
                  ) : null}

                  {/* Floating dock composer */}
                  <div className="dock-area">
                    <div className="dock-surface">
                      <div className="dock-composer">
                        <div className="dock-context">
                          <span className="context-chip">@file {activeFile?.name ?? "none"}</span>
                          <span className="context-chip">@terminal</span>
                          <span className="context-chip">/plan</span>
                        </div>
                        <div className="dock-textarea-wrap" style={{ position: "relative" }}>
                          {/* Autocomplete popup */}
                          {autocompleteType && (() => {
                            const atItems = [
                              { label: "@file", desc: "Reference a file", icon: <FileCode2 size={13} /> },
                              { label: "@terminal", desc: "Terminal context", icon: <TerminalSquare size={13} /> },
                              { label: "@workspace", desc: "Workspace context", icon: <Files size={13} /> },
                              { label: "@selection", desc: "Selected code", icon: <Braces size={13} /> },
                            ];
                            const slashItems = [
                              { label: "/plan", desc: "Create an implementation plan", icon: <Sparkles size={13} /> },
                              { label: "/review", desc: "Review code changes", icon: <Search size={13} /> },
                              { label: "/fix", desc: "Fix errors and bugs", icon: <Settings2 size={13} /> },
                              { label: "/explain", desc: "Explain code", icon: <MessageSquare size={13} /> },
                              { label: "/test", desc: "Write tests", icon: <FileCode2 size={13} /> },
                              { label: "/refactor", desc: "Refactor code", icon: <Braces size={13} /> },
                            ];
                            const items = autocompleteType === "@" ? atItems : slashItems;
                            const filtered = autocompleteQuery
                              ? items.filter((i) => i.label.toLowerCase().includes(autocompleteQuery.toLowerCase()))
                              : items;
                            if (filtered.length === 0) return null;
                            return (
                              <div className="autocomplete-popup">
                                {filtered.map((item, idx) => (
                                  <button
                                    key={item.label}
                                    type="button"
                                    className={`autocomplete-item${idx === autocompleteIndex ? " selected" : ""}`}
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      // Insert the command into prompt
                                      const before = prompt.slice(0, prompt.lastIndexOf(autocompleteType === "@" ? "@" : "/"));
                                      setPrompt(before + item.label + " ");
                                      setAutocompleteType(null);
                                      setAutocompleteQuery("");
                                      setAutocompleteIndex(0);
                                    }}
                                  >
                                    {item.icon}
                                    <span className="autocomplete-item-label">{item.label}</span>
                                    <span className="autocomplete-item-desc">{item.desc}</span>
                                  </button>
                                ))}
                              </div>
                            );
                          })()}
                          <textarea
                            value={prompt}
                            onChange={(event) => {
                              const val = event.target.value;
                              setPrompt(val);
                              // Detect @ or / trigger
                              const cursor = event.target.selectionStart ?? val.length;
                              const textBefore = val.slice(0, cursor);
                              const atMatch = textBefore.match(/@(\w*)$/);
                              const slashMatch = textBefore.match(/\/(\w*)$/);
                              if (atMatch) {
                                setAutocompleteType("@");
                                setAutocompleteQuery(atMatch[0]);
                                setAutocompleteIndex(0);
                              } else if (slashMatch && (textBefore === slashMatch[0] || textBefore[textBefore.length - slashMatch[0].length - 1] === " " || textBefore[textBefore.length - slashMatch[0].length - 1] === "\n")) {
                                setAutocompleteType("/");
                                setAutocompleteQuery(slashMatch[0]);
                                setAutocompleteIndex(0);
                              } else {
                                setAutocompleteType(null);
                                setAutocompleteQuery("");
                              }
                            }}
                            placeholder="Ask Alpha Code to inspect, plan, edit, or review"
                            rows={3}
                            onKeyDown={(event) => {
                              if (autocompleteType) {
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  setAutocompleteType(null);
                                  return;
                                }
                                if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                                  // Accept autocomplete if visible
                                  event.preventDefault();
                                  // Simulate clicking the selected item
                                  const popup = document.querySelector(".autocomplete-item.selected") as HTMLButtonElement | null;
                                  if (popup) {
                                    popup.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                                  } else {
                                    if (event.key === "Enter") void handleSubmitPrompt();
                                  }
                                  return;
                                }
                                if (event.key === "ArrowDown") {
                                  event.preventDefault();
                                  setAutocompleteIndex((i) => i + 1);
                                  return;
                                }
                                if (event.key === "ArrowUp") {
                                  event.preventDefault();
                                  setAutocompleteIndex((i) => Math.max(0, i - 1));
                                  return;
                                }
                              }
                              if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault();
                                void handleSubmitPrompt();
                              }
                            }}
                          />
                        </div>
                        <div className="dock-footer">
                          <div className="dock-hints">
                            <span>
                              <Command size={11} /> Commands
                            </span>
                            <span>
                              <Braces size={11} /> Context
                            </span>
                          </div>
                          {isStreaming ? (
                            <button className="titlebar-action danger" type="button" onClick={() => void handleStopStreaming()}>
                              <Square size={13} />
                              <span>Stop</span>
                            </button>
                          ) : (
                            <button className="titlebar-action primary" type="button" onClick={() => void handleSubmitPrompt()}>
                              {submitting ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />}
                              <span>{submitting ? "Sending" : "Send"}</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="dock-tray">
                      <div className="dock-tray-selectors">
                        <label className="dock-tray-select">
                          <span>{provider}</span>
                          <select
                            value={provider}
                            onChange={(e) => {
                              const next = e.target.value;
                              setProvider(next);
                              localStorage.setItem("ac:provider", next);
                              // Auto-select first enabled model for this provider
                              const p = snapshot?.providers.find((p) => p.label === next);
                              const firstEnabled = (p?.models ?? []).find((m) => !disabledModels[m]);
                              if (firstEnabled) {
                                setModel(firstEnabled);
                                localStorage.setItem("ac:model", firstEnabled);
                              }
                            }}
                          >
                            {(snapshot?.providers ?? []).map((p) => (
                              <option key={p.id} value={p.label}>{p.label}{p.status === "disconnected" ? " (no key)" : ""}</option>
                            ))}
                          </select>
                        </label>
                        <span className="dock-tray-sep">/</span>
                        <label className="dock-tray-select">
                          <span>{prettifyModelId(model)}</span>
                          <select
                            value={model}
                            onChange={(e) => {
                              setModel(e.target.value);
                              localStorage.setItem("ac:model", e.target.value);
                            }}
                          >
                            {(snapshot?.providers.find((p) => p.label === provider)?.models ?? [])
                              .filter((m) => !disabledModels[m])
                              .map((m) => (
                                <option key={m} value={m}>{prettifyModelId(m)}</option>
                              ))}
                          </select>
                        </label>
                      </div>
                      {(() => {
                        // Find provider ID from label
                        const currentProviderId = snapshot?.providers.find((p) => p.label === provider)?.id ?? "";
                        const usage = providerUsage.find((u) => u.providerId === currentProviderId);
                        const hasUsage = usage && usage.usageLabel !== "No usage yet" && usage.usageLabel !== "No API key";
                        const barPercent = usage?.usagePercent ?? 0;
                        const barColor = barPercent > 80 ? "var(--color-error)" : barPercent > 50 ? "#e8a832" : "var(--color-success)";

                        return (
                          <div className="dock-tray-usage">
                            {hasUsage ? (
                              <div className="dock-tray-context" title={usage.details}>
                                {usage.usagePercent !== null ? (
                                  <>
                                    <div className="context-bar">
                                      <div className="context-bar-fill" style={{ width: `${barPercent}%`, backgroundColor: barColor }} />
                                    </div>
                                    <span className="context-bar-label">{usage.usageLabel} ({barPercent.toFixed(1)}%)</span>
                                  </>
                                ) : (
                                  <span className="context-bar-label">{usage.usageLabel}</span>
                                )}
                              </div>
                            ) : null}
                            {sessionDetail ? (
                              <span className="dock-tray-requests" title={`${sessionUsage.requestCount} AI request${sessionUsage.requestCount !== 1 ? "s" : ""} in this session\n${sessionUsage.totalTokens > 0 ? `Tokens: ${formatTokens(sessionUsage.totalInputTokens)} in / ${formatTokens(sessionUsage.totalOutputTokens)} out (${formatTokens(sessionUsage.totalTokens)} total)` : ""}`}>
                                <Zap size={11} />
                                {sessionUsage.requestCount} req{sessionUsage.requestCount !== 1 ? "s" : ""}
                                {sessionUsage.totalTokens > 0 ? ` · ${formatTokens(sessionUsage.totalTokens)}` : ""}
                              </span>
                            ) : (
                              <span className="dock-tray-no-session">No session</span>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              </Panel>

              {/* Terminal panel (collapsible) */}
              {showTerminal ? (
                <>
                  <PanelResizeHandle className="resize-handle horizontal" />
                  <Panel defaultSize={30} minSize={14} maxSize={60}>
                    <section className="terminal-area">
                      <div className="terminal-header">
                        <div className="terminal-tabs">
                          <button
                            className={`terminal-tab${dockTab === "terminal" ? " active" : ""}`}
                            type="button"
                            onClick={() => setDockTab("terminal")}
                          >
                            <TerminalSquare size={13} />
                            <span>Terminal</span>
                          </button>
                          <button
                            className={`terminal-tab${dockTab === "changes" ? " active" : ""}`}
                            type="button"
                            onClick={() => setDockTab("changes")}
                          >
                            <FileDiff size={13} />
                            <span>Changes</span>
                          </button>
                          <button
                            className={`terminal-tab${dockTab === "activity" ? " active" : ""}`}
                            type="button"
                            onClick={() => setDockTab("activity")}
                          >
                            <Bot size={13} />
                            <span>Activity</span>
                          </button>
                        </div>

                        <div className="terminal-status-row">
                          {xtermReady ? (
                            <span className="terminal-connected">
                              <span className="auth-status-dot connected" /> PTY connected
                            </span>
                          ) : (
                            <span className="terminal-disconnected">
                              <LoaderCircle className="spin" size={11} /> Connecting...
                            </span>
                          )}
                          <div className="terminal-status-actions">
                            <button
                              className="toggle-panel-btn"
                              type="button"
                              title="Copy terminal content"
                              onClick={() => {
                                const term = xtermRef.current;
                                if (!term) return;
                                const buf = term.buffer.active;
                                const lines: string[] = [];
                                for (let i = 0; i < buf.length; i++) {
                                  const line = buf.getLine(i);
                                  if (line) lines.push(line.translateToString(true));
                                }
                                const text = lines.join("\n").trimEnd();
                                if (text) navigator.clipboard.writeText(text);
                              }}
                            >
                              <Copy size={12} />
                            </button>
                            <button
                              className="toggle-panel-btn"
                              type="button"
                              onClick={() => setShowTerminal(false)}
                              title="Close terminal"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="terminal-body">
                        <div
                          ref={xtermContainerRef}
                          className="xterm-container"
                          style={{ display: dockTab === "terminal" ? "block" : "none" }}
                        />

                        {dockTab === "changes" ? (
                          <div className="terminal-body-scroll compact-scroll">
                            {changedFiles.length === 0 ? (
                              <p className="empty-inline">No unsaved files.</p>
                            ) : (
                              <div className="changes-grid">
                                {changedFiles.map((file) => (
                                  <button key={file.id} className="change-row" type="button" onClick={() => openFile(file.id)}>
                                    <strong>{file.name}</strong>
                                    <span>{file.path}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : null}

                        {dockTab === "activity" ? (
                          <div className="terminal-body-scroll compact-scroll">
                            {sessionDetail ? (
                              <div className="activity-list">
                                {sessionDetail.messages
                                  .filter((message) => message.role === "system")
                                  .map((message) => (
                                    <article key={message.id} className="activity-row">
                                      <span>{message.content}</span>
                                      <small>{formatTime(message.createdAt)}</small>
                                    </article>
                                  ))}
                              </div>
                            ) : (
                              <p className="empty-inline">Session activity appears after you start a thread.</p>
                            )}
                          </div>
                        ) : null}
                      </div>
                    </section>
                  </Panel>
                </>
              ) : null}
            </PanelGroup>
          </Panel>

          {/* Right panel: editor (toggled) */}
          {showRightPanel ? (
            <>
              <PanelResizeHandle className="resize-handle vertical" />
              <Panel defaultSize={42} minSize={24} maxSize={64}>
                <section className="right-panel">
                  <div className="pane-header">
                    <div>
                      <span className="pane-kicker">Editor</span>
                      <h2>{activeFile?.path ?? "No file"}</h2>
                    </div>
                    <button className="pane-button" type="button" onClick={() => setShowRightPanel(false)}>
                      <X size={12} />
                      <span>Close</span>
                    </button>
                  </div>

                  <div className="context-summary-row">
                    <span>{activeFile?.language ?? ""}</span>
                    <span>{changedFiles.length} changed</span>
                  </div>

                  <div className="tab-strip compact-scroll">
                    {openFiles.map((file) => (
                      <button
                        key={file.id}
                        className={`tab-chip${activeFile?.id === file.id ? " active" : ""}`}
                        type="button"
                        onClick={() => setActiveFileId(file.id)}
                      >
                        <span>{file.name}</span>
                        {openFiles.length > 1 ? (
                          <span
                            className="tab-chip-close"
                            onClick={(event) => {
                              event.stopPropagation();
                              closeFile(file.id);
                            }}
                          >
                            x
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>

                  <div className="editor-layout">
                    <div className="editor-pane">
                      {activeFile ? (
                        <Editor
                          height="100%"
                          language={activeFile.language}
                          theme="vs-dark"
                          value={drafts[activeFile.id] ?? activeFile.content}
                          onChange={(value) => {
                            setDrafts((current) => ({
                              ...current,
                              [activeFile.id]: value ?? ""
                            }));
                          }}
                          options={{
                            minimap: { enabled: false },
                            fontSize: 13,
                            lineHeight: 20,
                            automaticLayout: true,
                            scrollBeyondLastLine: false,
                            smoothScrolling: true,
                            padding: { top: 10 },
                            wordWrap: "off"
                          }}
                        />
                      ) : (
                        <div className="empty-editor">Open a file to edit.</div>
                      )}
                    </div>

                    <div className="editor-sidebar compact-scroll">
                      {groupedFiles.map((group) => {
                        const expanded = expandedGroups[group.label] ?? true;
                        return (
                          <div key={group.label} className="tree-group">
                            <button
                              className="tree-header"
                              type="button"
                              onClick={() =>
                                setExpandedGroups((current) => ({
                                  ...current,
                                  [group.label]: !expanded
                                }))
                              }
                            >
                              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                              <span>{group.label}</span>
                            </button>
                            {expanded ? (
                              <div className="tree-items">
                                {group.items.map((file) => {
                                  const dirty = changedFiles.some((item) => item.id === file.id);
                                  return (
                                    <button
                                      key={file.id}
                                      className={`tree-item${activeFile?.id === file.id ? " active" : ""}`}
                                      type="button"
                                      onClick={() => openFile(file.id)}
                                    >
                                      <FileCode2 size={12} />
                                      <span>{file.path.replace(`${group.label}/`, "")}</span>
                                      {dirty ? <span className="dirty-dot" /> : null}
                                    </button>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="context-footer">
                    <button className="pane-button" type="button" onClick={() => void loadWorkspace()}>
                      <Search size={12} />
                      <span>Refresh</span>
                    </button>
                    <button className="titlebar-action primary" type="button" onClick={() => void handleSaveFile()}>
                      {saving ? <LoaderCircle className="spin" size={13} /> : <FileCode2 size={13} />}
                      <span>{saving ? "Saving" : "Save"}</span>
                    </button>
                  </div>
                </section>
              </Panel>
            </>
          ) : null}
        </PanelGroup>
      </div>

      {/* ===== Settings overlay ===== */}
      {showSettings ? (
        <div className="overlay-backdrop" onClick={() => setShowSettings(false)}>
          <div className="overlay-panel settings-overlay" onClick={(e) => e.stopPropagation()}>
            <div className="overlay-header">
              <h2>Settings</h2>
              <button className="overlay-close" type="button" onClick={() => setShowSettings(false)}>
                <X size={14} />
              </button>
            </div>

            <div className="overlay-body compact-scroll">
              {/* --- Provider Auth Section --- */}
              <div className="overlay-section">
                <h3 className="overlay-section-title">Providers</h3>

                {/* GitHub Copilot — OAuth Device Flow */}
                <div className="auth-provider-card">
                  <div className="auth-provider-header">
                    <div className="auth-provider-info">
                      <span className={`auth-status-dot ${authStatus?.providers.find((p) => p.id === "copilot")?.status === "connected" ? "connected" : "disconnected"}`} />
                      <strong>GitHub Copilot</strong>
                    </div>
                    <span className="auth-method-badge">
                      {authStatus?.providers.find((p) => p.id === "copilot")?.method === "env"
                        ? "ENV"
                        : authStatus?.providers.find((p) => p.id === "copilot")?.method === "oauth"
                          ? "OAuth"
                          : "—"}
                    </span>
                  </div>

                  {authStatus?.providers.find((p) => p.id === "copilot")?.status === "connected" ? (
                    <div className="auth-connected-row">
                      <span className="auth-connected-label">
                        <Check size={12} />
                        Connected
                      </span>
                      {authStatus?.providers.find((p) => p.id === "copilot")?.method === "oauth" ? (
                        <button
                          className="auth-remove-btn"
                          type="button"
                          onClick={() => {
                            void removeApiKey("copilot-oauth");
                          }}
                          disabled={removingKey === "copilot-oauth"}
                        >
                          <LogOut size={12} />
                          <span>Logout</span>
                        </button>
                      ) : null}
                    </div>
                  ) : githubDevice ? (
                    <div className="github-device-flow">
                      <p className="device-flow-instruction">
                        Go to <a href={githubDevice.verificationUri} target="_blank" rel="noopener noreferrer">
                          {githubDevice.verificationUri} <ExternalLink size={11} />
                        </a> and enter the code:
                      </p>
                      <div className="device-code-display">
                        <code>{githubDevice.userCode}</code>
                        <button
                          className="copy-code-btn"
                          type="button"
                          onClick={() => copyToClipboard(githubDevice.userCode)}
                        >
                          {copiedCode ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                      </div>
                      {githubPolling ? (
                        <div className="device-flow-polling">
                          <LoaderCircle className="spin" size={13} />
                          <span>Waiting for authorization...</span>
                        </div>
                      ) : null}
                      <button
                        className="auth-text-btn"
                        type="button"
                        onClick={() => {
                          setGithubPolling(false);
                          setGithubDevice(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="auth-btn-group">
                      <button
                        className="auth-login-btn"
                        type="button"
                        onClick={() => void startGitHubLogin()}
                        disabled={githubStarting}
                      >
                        {githubStarting ? (
                          <LoaderCircle className="spin" size={13} />
                        ) : (
                          <LogIn size={13} />
                        )}
                        <span>{githubStarting ? "Starting..." : "Login with GitHub"}</span>
                      </button>
                      <p className="auth-helper-text">
                        Requires a GitHub Copilot subscription
                      </p>
                    </div>
                  )}
                </div>

                {/* API Key providers: OpenAI, Anthropic, OpenRouter */}
                {(["openai", "anthropic", "openrouter"] as const).map((providerId) => {
                  const providerInfo = authStatus?.providers.find((p) => p.id === providerId);
                  const isConnected = providerInfo?.status === "connected";
                  const method = providerInfo?.method ?? "none";
                  const labelText = providerInfo?.label ?? providerId;
                  const keyInput = apiKeyInputs[providerId] ?? "";
                  const isVisible = apiKeyVisible[providerId] ?? false;

                  return (
                    <div key={providerId} className="auth-provider-card">
                      <div className="auth-provider-header">
                        <div className="auth-provider-info">
                          <span className={`auth-status-dot ${isConnected ? "connected" : "disconnected"}`} />
                          <strong>{labelText}</strong>
                        </div>
                        <span className="auth-method-badge">
                          {method === "env" ? "ENV" : method === "stored_key" ? "Key" : "—"}
                        </span>
                      </div>

                      {isConnected ? (
                        <div className="auth-connected-row">
                          <span className="auth-connected-label">
                            <Check size={12} />
                            Connected
                          </span>
                          {method === "stored_key" ? (
                            <button
                              className="auth-remove-btn"
                              type="button"
                              onClick={() => void removeApiKey(providerId)}
                              disabled={removingKey === providerId}
                            >
                              <X size={12} />
                              <span>{removingKey === providerId ? "..." : "Remove"}</span>
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <div className="auth-key-input-row">
                          <div className="auth-key-input-wrap">
                            <Key size={12} className="auth-key-icon" />
                            <input
                              type={isVisible ? "text" : "password"}
                              value={keyInput}
                              onChange={(e) =>
                                setApiKeyInputs((current) => ({ ...current, [providerId]: e.target.value }))
                              }
                              placeholder={`Paste ${labelText} API key`}
                            />
                            <button
                              className="auth-visibility-btn"
                              type="button"
                              onClick={() =>
                                setApiKeyVisible((current) => ({ ...current, [providerId]: !isVisible }))
                              }
                            >
                              {isVisible ? <EyeOff size={12} /> : <Eye size={12} />}
                            </button>
                          </div>
                          <button
                            className="auth-save-btn"
                            type="button"
                            onClick={() => void saveApiKey(providerId, keyInput)}
                            disabled={!keyInput.trim() || savingKey === providerId}
                          >
                            {savingKey === providerId ? (
                              <LoaderCircle className="spin" size={12} />
                            ) : (
                              <Check size={12} />
                            )}
                            <span>{savingKey === providerId ? "..." : "Save"}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* --- Model Toggles Section --- */}
              <div className="overlay-section">
                <h3 className="overlay-section-title">Models</h3>
                <p className="overlay-section-desc">Enable or disable models per provider. Only enabled models appear in the model dropdown.</p>
                {(snapshot?.providers ?? []).map((prov) => (
                  <div key={prov.id} className="model-toggle-group">
                    <div className="model-toggle-provider">{prov.label}</div>
                    {(prov.models ?? []).map((m) => {
                      const isOff = disabledModels[m] === true;
                      return (
                        <label key={m} className="model-toggle-row">
                          <span className="model-toggle-name" title={m}>{prettifyModelId(m)}</span>
                          <span className="model-toggle-raw">{m}</span>
                          <button
                            type="button"
                            className={`model-toggle-switch${isOff ? "" : " on"}`}
                            onClick={() => setDisabledModels((prev) => ({ ...prev, [m]: !isOff }))}
                          >
                            <span className="model-toggle-knob" />
                          </button>
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>

              {/* --- Environment Section --- */}
              <div className="overlay-section">
                <h3 className="overlay-section-title">Environment</h3>
                <div className="setting-row">
                  <span>Server</span>
                  <strong>{serverUrl}</strong>
                </div>
                <div className="setting-row">
                  <span>Workspace</span>
                  <strong>{snapshot?.workspace.root}</strong>
                </div>
                <div className="setting-row">
                  <span>Desktop shell</span>
                  <strong>Electron</strong>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ===== Search popup (Cmd+K) ===== */}
      {showSearchPopup ? (
        <div className="overlay-backdrop" onClick={() => { setShowSearchPopup(false); setSearchQuery(""); }}>
          <div className="search-popup" onClick={(e) => e.stopPropagation()}>
            <div className="search-popup-input-row">
              <Search size={14} className="search-popup-icon" />
              <input
                ref={searchPopupRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search files, sessions, and commands..."
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setShowSearchPopup(false);
                    setSearchQuery("");
                  }
                  if (e.key === "Enter") {
                    const hit = filteredFiles[0];
                    if (hit) {
                      openFile(hit.id);
                      setShowRightPanel(true);
                      setShowSearchPopup(false);
                      setSearchQuery("");
                    }
                  }
                }}
              />
            </div>
            <div className="search-popup-results compact-scroll">
              {searchQuery.trim() ? (
                filteredFiles.length > 0 ? (
                  filteredFiles.slice(0, 20).map((file) => (
                    <button
                      key={file.id}
                      className="search-popup-result"
                      type="button"
                      onClick={() => {
                        openFile(file.id);
                        setShowRightPanel(true);
                        setShowSearchPopup(false);
                        setSearchQuery("");
                      }}
                    >
                      <FileCode2 size={13} />
                      <div className="search-popup-result-text">
                        <strong>{file.name}</strong>
                        <span>{file.path}</span>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="search-popup-empty">No results</div>
                )
              ) : (
                <div className="search-popup-hint">
                  <span>Type to search files and content</span>
                  <div className="search-popup-shortcuts">
                    <span><kbd>Enter</kbd> Open file</span>
                    <span><kbd>Esc</kbd> Close</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* ===== Project switcher popup ===== */}
      {showProjectSwitcher ? (
        <div className="overlay-backdrop" onClick={() => { setShowProjectSwitcher(false); setProjectFilter(""); setProjectPathInput(""); }}>
          <div className="branch-popup project-popup" onClick={(e) => e.stopPropagation()}>
            <div className="branch-popup-header">
              <FolderGit2 size={14} />
              <span>Switch Project</span>
              <button className="branch-popup-close" type="button" onClick={() => setShowProjectSwitcher(false)}>
                <X size={14} />
              </button>
            </div>

            <div className="branch-popup-search">
              <Search size={13} />
              <input
                ref={projectFilterRef}
                type="text"
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                placeholder="Filter projects..."
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setShowProjectSwitcher(false); setProjectFilter(""); }
                }}
              />
            </div>

            {projectError ? (
              <div className="branch-popup-error">
                <CircleAlert size={12} />
                <span>{projectError}</span>
              </div>
            ) : null}

            {projectLoading && recentProjects.length === 0 ? (
              <div className="branch-popup-loading">
                <LoaderCircle className="spin" size={16} />
                <span>Loading projects...</span>
              </div>
            ) : (
              <div className="branch-popup-list compact-scroll">
                {/* Current project */}
                {recentProjects
                  .filter((p) => p.path === snapshot?.workspace?.root)
                  .filter((p) => !projectFilter || p.name.toLowerCase().includes(projectFilter.toLowerCase()) || p.path.toLowerCase().includes(projectFilter.toLowerCase()))
                  .map((p) => (
                    <div key={p.path} className="branch-row current">
                      <FolderGit2 size={13} />
                      <span className="branch-name">{p.name}</span>
                      <span className="branch-badge">current</span>
                    </div>
                  ))}

                {/* Other recent projects */}
                {recentProjects
                  .filter((p) => p.path !== snapshot?.workspace?.root)
                  .filter((p) => !projectFilter || p.name.toLowerCase().includes(projectFilter.toLowerCase()) || p.path.toLowerCase().includes(projectFilter.toLowerCase()))
                  .map((p) => (
                    <button
                      key={p.path}
                      className="branch-row"
                      type="button"
                      disabled={projectLoading}
                      onClick={() => handleSwitchProject(p.path)}
                      title={p.path}
                    >
                      <FolderGit2 size={13} />
                      <span className="branch-name">{p.name}</span>
                      <span className="branch-tag">{p.path.replace(/^\/Users\/[^/]+/, "~")}</span>
                    </button>
                  ))}

                {/* No results */}
                {recentProjects.filter((p) => !projectFilter || p.name.toLowerCase().includes(projectFilter.toLowerCase()) || p.path.toLowerCase().includes(projectFilter.toLowerCase())).length === 0 ? (
                  <div className="branch-popup-empty">No matching projects</div>
                ) : null}
              </div>
            )}

            {/* Open project by path or native picker */}
            <div className="branch-popup-create">
              <div className="branch-create-row">
                <FolderGit2 size={13} />
                <input
                  type="text"
                  value={projectPathInput}
                  onChange={(e) => setProjectPathInput(e.target.value)}
                  placeholder="Paste a folder path..."
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleOpenProjectPath();
                    if (e.key === "Escape") { setShowProjectSwitcher(false); setProjectPathInput(""); }
                  }}
                />
                <button
                  className="branch-create-btn"
                  type="button"
                  disabled={!projectPathInput.trim() || projectLoading}
                  onClick={handleOpenProjectPath}
                >
                  {projectLoading ? <LoaderCircle className="spin" size={12} /> : "Open"}
                </button>
              </div>
              {isElectron ? (
                <button
                  className="project-browse-btn"
                  type="button"
                  disabled={projectLoading}
                  onClick={handlePickFolder}
                >
                  <Files size={12} />
                  <span>Browse...</span>
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* ===== Branch switcher popup ===== */}
      {showBranchSwitcher ? (
        <div className="overlay-backdrop" onClick={() => { setShowBranchSwitcher(false); setBranchFilter(""); setNewBranchName(""); }}>
          <div className="branch-popup" onClick={(e) => e.stopPropagation()}>
            <div className="branch-popup-header">
              <GitBranch size={14} />
              <span>Switch Branch</span>
              <button className="branch-popup-close" type="button" onClick={() => setShowBranchSwitcher(false)}>
                <X size={14} />
              </button>
            </div>

            <div className="branch-popup-search">
              <Search size={13} />
              <input
                ref={branchFilterRef}
                type="text"
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
                placeholder="Filter branches..."
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setShowBranchSwitcher(false); setBranchFilter(""); }
                }}
              />
            </div>

            {branchError ? (
              <div className="branch-popup-error">
                <CircleAlert size={12} />
                <span>{branchError}</span>
              </div>
            ) : null}

            {branchLoading && !branchData ? (
              <div className="branch-popup-loading">
                <LoaderCircle className="spin" size={16} />
                <span>Loading branches...</span>
              </div>
            ) : branchData ? (
              <div className="branch-popup-list compact-scroll">
                {/* Current branch */}
                {branchData.current && (!branchFilter || branchData.current.toLowerCase().includes(branchFilter.toLowerCase())) ? (
                  <div className="branch-row current">
                    <GitBranch size={13} />
                    <span className="branch-name">{branchData.current}</span>
                    <span className="branch-badge">current</span>
                  </div>
                ) : null}

                {/* Local branches */}
                {branchData.local
                  .filter((b) => b !== branchData.current && (!branchFilter || b.toLowerCase().includes(branchFilter.toLowerCase())))
                  .map((b) => (
                    <button
                      key={b}
                      className="branch-row"
                      type="button"
                      disabled={branchLoading}
                      onClick={() => handleCheckoutBranch(b)}
                    >
                      <GitBranch size={13} />
                      <span className="branch-name">{b}</span>
                      <span className="branch-tag">local</span>
                    </button>
                  ))}

                {/* Remote-only branches */}
                {branchData.remote
                  .filter((b) => !branchFilter || b.toLowerCase().includes(branchFilter.toLowerCase()))
                  .map((b) => (
                    <button
                      key={`remote-${b}`}
                      className="branch-row"
                      type="button"
                      disabled={branchLoading}
                      onClick={() => handleCheckoutBranch(b)}
                    >
                      <GitBranch size={13} />
                      <span className="branch-name">{b}</span>
                      <span className="branch-tag remote">remote</span>
                    </button>
                  ))}

                {/* No results */}
                {(() => {
                  const q = branchFilter.toLowerCase();
                  const anyMatch = branchData.current.toLowerCase().includes(q)
                    || branchData.local.some((b) => b.toLowerCase().includes(q))
                    || branchData.remote.some((b) => b.toLowerCase().includes(q));
                  return !anyMatch ? <div className="branch-popup-empty">No matching branches</div> : null;
                })()}
              </div>
            ) : null}

            {/* Create new branch */}
            <div className="branch-popup-create">
              <div className="branch-create-row">
                <GitBranchPlus size={13} />
                <input
                  type="text"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  placeholder="New branch name..."
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateBranch();
                    if (e.key === "Escape") { setShowBranchSwitcher(false); setNewBranchName(""); }
                  }}
                />
                <button
                  className="branch-create-btn"
                  type="button"
                  disabled={!newBranchName.trim() || branchLoading}
                  onClick={handleCreateBranch}
                >
                  {branchLoading ? <LoaderCircle className="spin" size={12} /> : "Create"}
                </button>
              </div>
              {branchData?.hasUncommittedChanges ? (
                <div className="branch-popup-warning">
                  <CircleAlert size={11} />
                  <span>You have uncommitted changes</span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="toast-error">
          <span>{error}</span>
          <button className="toast-close" type="button" onClick={() => setError("")}>
            <X size={12} />
          </button>
        </div>
      ) : null}
    </main>
  );
}
