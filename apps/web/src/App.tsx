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
  Key,
  LayoutPanelTop,
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
  X
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { APP_NAME, type AuthStatusResponse, type CommandRun, type GitHubDeviceCodeResponse, type GitHubPollResponse, type ProviderId, type SessionDetail, type WorkspaceSnapshot } from "@alpha-code/shared";

/* Electron preload exposes window.alphaCode on desktop */
interface AlphaCodeBridge {
  platform: "darwin" | "win32" | "linux";
  windowControl: (action: "minimize" | "maximize" | "close") => void;
  openExternal: (url: string) => void;
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
type SidebarTab = "chat" | "files" | "search" | "git" | "settings";
type FsEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number | null;
};

const serverUrl = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3030";
const wsUrl = import.meta.env.VITE_WS_URL ?? "ws://127.0.0.1:3031";

const railItems: Array<{ key: SidebarTab; icon: typeof MessageSquare; label: string }> = [
  { key: "chat", icon: MessageSquare, label: "Threads" },
  { key: "files", icon: Files, label: "Explorer" },
  { key: "search", icon: Search, label: "Search" },
  { key: "git", icon: FolderGit2, label: "Changes" },
  { key: "settings", icon: Settings2, label: "Settings" }
];

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
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

  async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
      throw new Error(body?.message ?? body?.error ?? `Request failed: ${response.status}`);
    }
    return (await response.json()) as T;
  }

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

    const es = new EventSource(`${serverUrl}/api/sessions/${sessionId}/stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type: "connected" | "token" | "done" | "error";
          messageId?: string;
          token?: string;
          error?: string;
        };

        if (data.type === "token" && data.token) {
          if (data.messageId && !streamingContentRef.current) {
            setStreamingMessageId(data.messageId);
          }
          streamingContentRef.current += data.token;
          setStreamingContent(streamingContentRef.current);
        } else if (data.type === "done") {
          // Stream complete — reload session to get final message from server
          setStreamingContent("");
          setStreamingMessageId(null);
          streamingContentRef.current = "";
          // Fetch the final session state
          fetchJson<SessionDetail>(`${serverUrl}/api/sessions/${sessionId}`)
            .then((payload) => setSessionDetail(payload))
            .catch(() => undefined);
          es.close();
          eventSourceRef.current = null;
        } else if (data.type === "error") {
          // Error — reload session and close
          setStreamingContent("");
          setStreamingMessageId(null);
          streamingContentRef.current = "";
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
  }, []);

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

  // Persist key state to localStorage
  useEffect(() => { localStorage.setItem("ac:sessionId", activeSessionId); }, [activeSessionId]);
  useEffect(() => { localStorage.setItem("ac:provider", provider); }, [provider]);
  useEffect(() => { localStorage.setItem("ac:model", model); }, [model]);

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Cmd+K — open search panel and focus input
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSidebarTab("search");
        // Focus the search input after React renders
        requestAnimationFrame(() => {
          const input = document.querySelector<HTMLInputElement>(".search-panel input");
          input?.focus();
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
      // Escape — close search / clear error
      if (e.key === "Escape") {
        if (error) setError("");
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [error]);

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

    if (!activeSessionId && payload.sessions[0]) {
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
    setActiveSessionId("");
    setSessionDetail(null);
    setPrompt("");
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
          <div className="brand-lockup">
            <span className="logo-block" />
            <span>{APP_NAME}</span>
          </div>
          <div className="titlebar-chip">
            <LayoutPanelTop size={12} />
            <span>Desktop</span>
          </div>
          <div className="titlebar-chip muted">
            <FolderGit2 size={12} />
            <span>{snapshot?.workspace.name}</span>
          </div>
          <div className="titlebar-chip muted">
            <GitBranch size={12} />
            <span>{snapshot?.workspace?.branch ?? "main"}</span>
          </div>
        </div>

        <div className="titlebar-center">
          <button className="command-palette" type="button" onClick={() => setSidebarTab("search")}>
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
          <button className="titlebar-action primary" type="button" onClick={handleNewSession}>
            <Plus size={13} />
            <span>New</span>
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
                          onClick={() => setActiveSessionId(session.id)}
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

            {sidebarTab === "files" ? (
              <>
                <div className="pane-header">
                  <div>
                    <span className="pane-kicker">Workspace</span>
                    <h2>Explorer</h2>
                  </div>
                  <button className="pane-button" type="button" onClick={() => void loadFs("apps")}>
                    <Files size={12} />
                    <span>Refresh</span>
                  </button>
                </div>

                <div className="fs-path-row">
                  <button className="path-chip" type="button" onClick={() => void loadFs("apps")}>
                    apps
                  </button>
                  <button className="path-chip" type="button" onClick={() => void loadFs("packages")}>
                    packages
                  </button>
                  <button className="path-chip" type="button" onClick={() => void loadFs(".")}>
                    root
                  </button>
                </div>

                <div className="file-system-list compact-scroll">
                  {fsEntries.map((entry) => (
                    <button
                      key={entry.path}
                      className="fs-entry"
                      type="button"
                      onClick={() => {
                        if (entry.type === "directory") {
                          void loadFs(entry.path);
                          return;
                        }
                        const file = files.find((item) => item.path === entry.path);
                        if (file) {
                          openFile(file.id);
                        }
                      }}
                    >
                      <span className="fs-entry-icon">
                        {entry.type === "directory" ? <ChevronRight size={12} /> : <FileCode2 size={12} />}
                      </span>
                      <span className="fs-entry-label">{entry.path}</span>
                    </button>
                  ))}
                </div>
                <div className="sidebar-footer-note compact">
                  <span>Path</span>
                  <strong>{fsPath}</strong>
                </div>
              </>
            ) : null}

            {sidebarTab === "search" ? (
              <>
                <div className="pane-header">
                  <div>
                    <span className="pane-kicker">Search</span>
                    <h2>Workspace Search</h2>
                  </div>
                </div>
                <div className="search-panel">
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search file paths and content"
                  />
                </div>
                <div className="search-results compact-scroll">
                  {filteredFiles.slice(0, 80).map((file) => (
                    <button key={file.id} className="search-result" type="button" onClick={() => openFile(file.id)}>
                      <strong>{file.name}</strong>
                      <span>{file.path}</span>
                    </button>
                  ))}
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

            {sidebarTab === "settings" ? (
              <>
                <div className="pane-header">
                  <div>
                    <span className="pane-kicker">Settings</span>
                    <h2>Providers</h2>
                  </div>
                  <button className="pane-button" type="button" onClick={() => void loadAuthStatus()}>
                    <Search size={12} />
                    <span>Refresh</span>
                  </button>
                </div>
                <div className="settings-stack compact-scroll">
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
                    const label = providerInfo?.label ?? providerId;
                    const keyInput = apiKeyInputs[providerId] ?? "";
                    const isVisible = apiKeyVisible[providerId] ?? false;

                    return (
                      <div key={providerId} className="auth-provider-card">
                        <div className="auth-provider-header">
                          <div className="auth-provider-info">
                            <span className={`auth-status-dot ${isConnected ? "connected" : "disconnected"}`} />
                            <strong>{label}</strong>
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
                                placeholder={`Paste ${label} API key`}
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

                  {/* Environment info */}
                  <div className="auth-section-divider">
                    <span>Environment</span>
                  </div>
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
                        {sessionDetail.messages.map((message) => (
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
                          </article>
                        ))}
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
                          <button className="welcome-card" type="button" onClick={() => setSidebarTab("files")}>
                            <Files size={16} />
                            <div>
                              <strong>Browse Files</strong>
                              <span>Explore your project tree</span>
                            </div>
                          </button>
                          <button className="welcome-card" type="button" onClick={() => setSidebarTab("settings")}>
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

                  {/* Floating dock composer */}
                  <div className="dock-area">
                    <div className="dock-surface">
                      <div className="dock-composer">
                        <div className="dock-context">
                          <span className="context-chip">@file {activeFile?.name ?? "none"}</span>
                          <span className="context-chip">@terminal</span>
                          <span className="context-chip">/plan</span>
                        </div>
                        <div className="dock-textarea-wrap">
                          <textarea
                            value={prompt}
                            onChange={(event) => setPrompt(event.target.value)}
                            placeholder="Ask Alpha Code to inspect, plan, edit, or review"
                            rows={3}
                            onKeyDown={(event) => {
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
                              // Auto-select first model for this provider
                              const p = snapshot?.providers.find((p) => p.label === next);
                              if (p?.models?.[0]) {
                                setModel(p.models[0]);
                                localStorage.setItem("ac:model", p.models[0]);
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
                          <span>{model}</span>
                          <select
                            value={model}
                            onChange={(e) => {
                              setModel(e.target.value);
                              localStorage.setItem("ac:model", e.target.value);
                            }}
                          >
                            {(snapshot?.providers.find((p) => p.label === provider)?.models ?? []).map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <span>{sessionDetail ? sessionDetail.messages.length + " messages" : "No session"}</span>
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
                        {dockTab === "terminal" ? (
                          <div
                            ref={xtermContainerRef}
                            className="xterm-container"
                          />
                        ) : null}

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
