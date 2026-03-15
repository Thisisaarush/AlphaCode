import {
  useState,
  useRef,
  type KeyboardEvent,
  type ChangeEvent,
  type RefObject,
} from "react";
import {
  ChevronDown,
  Search,
  LoaderCircle,
  Play,
  Square,
  FileCode2,
  TerminalSquare,
  Files,
  Braces,
  Sparkles,
  MessageSquare,
  Settings2,
  Zap,
} from "lucide-react";
import type { WorkspaceSnapshot, ProviderId } from "@alpha-code/shared";
import "./Dock.scss";

interface Provider {
  id: string;
  label: string;
  model: string;
  models?: string[];
  status: string;
  modelContextLimits?: Record<string, number>;
}

interface DockProps {
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  onStopStreaming: () => void;
  isStreaming: boolean;
  submitting: boolean;
  mode: "plan" | "build";
  onModeChange: (mode: "plan" | "build") => void;
  provider: string;
  model: string;
  providers: Provider[];
  disabledModels: Record<string, boolean>;
  sessionDetail: SessionDetail | null;
  sessionUsage: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    requestCount: number;
    estimatedContextTokens: number;
  };
  providerUsage: Array<{
    providerId: string;
    usagePercent: number | null;
    usageLabel: string;
    details: string;
    hasQuota: boolean;
  }>;
  modelContextLimits: Record<string, number>;
}

interface SessionDetail {
  id: string;
  model: string;
}

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "gpt-5": 1000000,
  "gpt-4o": 128000,
  o1: 200000,
  "o1-mini": 128000,
  "claude-opus-4-20250514": 200000,
  "claude-sonnet-4-20250514": 200000,
  "gemini-2.5-pro": 2000000,
  "gemini-2.5-flash": 1000000,
};

function getModelContextLimit(
  modelId: string,
  serverLimits?: Record<string, number>,
): number {
  if (serverLimits && serverLimits[modelId]) return serverLimits[modelId];
  if (MODEL_CONTEXT_LIMITS[modelId]) return MODEL_CONTEXT_LIMITS[modelId];
  const base = modelId
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "");
  if (MODEL_CONTEXT_LIMITS[base]) return MODEL_CONTEXT_LIMITS[base];
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (modelId.startsWith(key)) return limit;
  }
  return 128000;
}

function getModelContextLabel(
  modelId: string,
  serverLimits?: Record<string, number>,
): string | undefined {
  const limit = getModelContextLimit(modelId, serverLimits);
  if (limit >= 1000000) return `${(limit / 1000000).toFixed(1)}M`;
  if (limit >= 100000) return `${(limit / 1000).toFixed(0)}K`;
  return undefined;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function prettifyModelId(raw: string): string {
  const known: Record<string, string> = {
    "gpt-4": "GPT 4",
    "gpt-4o": "GPT 4o",
    "gpt-4o-mini": "GPT 4o Mini",
    o1: "O1",
    "o1-mini": "O1 Mini",
  };
  const stripped = raw
    .replace(/-\d{4}-?\d{2}-?\d{2}$/, "")
    .replace(/-\d{8}$/, "");
  if (known[stripped]) return known[stripped];
  if (raw.includes("/")) {
    const parts = raw.split("/");
    return prettifyModelId(parts[parts.length - 1] ?? raw);
  }
  return stripped
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

function highlightLabel(label: string, query: string): React.ReactNode {
  if (!query) return label;
  const idx = label.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return label;
  return (
    <>
      {label.slice(0, idx)}
      <strong>{label.slice(idx, idx + query.length)}</strong>
      {label.slice(idx + query.length)}
    </>
  );
}

export function Dock({
  prompt,
  onPromptChange,
  onSubmit,
  onStopStreaming,
  isStreaming,
  submitting,
  mode,
  onModeChange,
  provider,
  model,
  providers,
  disabledModels,
  sessionDetail,
  sessionUsage,
  providerUsage,
  modelContextLimits,
}: DockProps) {
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [autocompleteType, setAutocompleteType] = useState<"@" | "/" | null>(
    null,
  );
  const [autocompleteQuery, setAutocompleteQuery] = useState("");
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  const atItems = [
    {
      label: "@file",
      insert: "@file",
      desc: "Reference a file",
      icon: <FileCode2 size={13} />,
    },
    {
      label: "@terminal",
      insert: "@terminal",
      desc: "Terminal context",
      icon: <TerminalSquare size={13} />,
    },
    {
      label: "@workspace",
      insert: "@workspace",
      desc: "Workspace context",
      icon: <Files size={13} />,
    },
    {
      label: "@selection",
      insert: "@selection",
      desc: "Selected code",
      icon: <Braces size={13} />,
    },
  ];
  const slashItems = [
    {
      label: "/plan",
      insert: "plan",
      desc: "Create an implementation plan",
      icon: <Sparkles size={13} />,
    },
    {
      label: "/review",
      insert: "review",
      desc: "Review code changes",
      icon: <Search size={13} />,
    },
    {
      label: "/fix",
      insert: "fix",
      desc: "Fix errors and bugs",
      icon: <Settings2 size={13} />,
    },
    {
      label: "/explain",
      insert: "explain",
      desc: "Explain code",
      icon: <MessageSquare size={13} />,
    },
  ];

  const handleTextChange = (value: string) => {
    onPromptChange(value);
    const cursor =
      (document.activeElement as HTMLTextAreaElement)?.selectionStart ??
      value.length;
    const textBefore = value.slice(0, cursor);
    const atMatch = textBefore.match(/@(\w*)$/);
    const slashMatch = textBefore.match(/\/(\w*)$/);
    if (atMatch) {
      setAutocompleteType("@");
      setAutocompleteQuery(atMatch[1] ?? "");
      setAutocompleteIndex(0);
    } else if (
      slashMatch &&
      (textBefore === slashMatch[0] ||
        textBefore[textBefore.length - slashMatch[0].length - 1] === " ")
    ) {
      setAutocompleteType("/");
      setAutocompleteQuery(slashMatch[1] ?? "");
      setAutocompleteIndex(0);
    } else {
      setAutocompleteType(null);
      setAutocompleteQuery("");
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (autocompleteType) {
      if (
        autocompleteType === "/" &&
        (e.key === " " || (e.key === "Enter" && !e.shiftKey))
      ) {
        const exact = slashItems.find(
          (i) =>
            i.label.slice(1).toLowerCase() === autocompleteQuery.toLowerCase(),
        );
        if (exact) {
          e.preventDefault();
          const before = prompt.slice(0, prompt.lastIndexOf("/"));
          onPromptChange(before + exact.insert + " ");
          setAutocompleteType(null);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAutocompleteType(null);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const popup = document.querySelector(
          ".autocomplete-item.selected",
        ) as HTMLButtonElement | null;
        if (popup)
          popup.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        else if (e.key === "Enter") onSubmit();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAutocompleteIndex((i) => i + 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAutocompleteIndex((i) => Math.max(0, i - 1));
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  const connectedProviders = providers.filter((p) => p.status === "connected");
  const allModelsWithProvider = connectedProviders.flatMap((p) =>
    (p.models ?? [])
      .filter((m) => !disabledModels[m])
      .map((m) => ({ model: m, provider: p.label, providerId: p.id })),
  );
  const filteredModels = modelSearchQuery
    ? allModelsWithProvider.filter(
        (item) =>
          item.model.toLowerCase().includes(modelSearchQuery.toLowerCase()) ||
          item.provider.toLowerCase().includes(modelSearchQuery.toLowerCase()),
      )
    : allModelsWithProvider;
  const groupedByProvider: Record<string, typeof filteredModels> = {};
  filteredModels.forEach((item) => {
    if (!groupedByProvider[item.provider])
      groupedByProvider[item.provider] = [];
    groupedByProvider[item.provider].push(item);
  });

  const currentProviderId =
    providers.find((p) => p.label === provider)?.id ?? "";
  const usage = providerUsage.find((u) => u.providerId === currentProviderId);
  const hasUsage =
    usage &&
    usage.usageLabel !== "No usage yet" &&
    usage.usageLabel !== "No API key";
  const barPercent = usage?.usagePercent ?? 0;
  const barColor =
    barPercent > 80
      ? "var(--error)"
      : barPercent > 50
        ? "#e8a832"
        : "var(--success)";
  const modelMaxContext = getModelContextLimit(model, modelContextLimits);
  const contextUsed = sessionUsage.estimatedContextTokens;
  const contextPercent =
    modelMaxContext > 0
      ? Math.min((contextUsed / modelMaxContext) * 100, 100)
      : 0;
  const contextColor =
    contextPercent > 85
      ? "var(--error)"
      : contextPercent > 60
        ? "#e8a832"
        : "var(--success)";

  return (
    <div className="dock-area">
      <div className="dock-surface">
        <div className="dock-composer">
          <div className="dock-textarea-wrap" style={{ position: "relative" }}>
            {autocompleteType &&
              (() => {
                const items = autocompleteType === "@" ? atItems : slashItems;
                const filtered = autocompleteQuery
                  ? items.filter((i) =>
                      i.label
                        .toLowerCase()
                        .includes(autocompleteQuery.toLowerCase()),
                    )
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
                          const before = prompt.slice(
                            0,
                            prompt.lastIndexOf(
                              autocompleteType === "@" ? "@" : "/",
                            ),
                          );
                          onPromptChange(before + item.insert + " ");
                          setAutocompleteType(null);
                          setAutocompleteQuery("");
                          setAutocompleteIndex(0);
                        }}
                      >
                        {item.icon}
                        <span className="autocomplete-item-label">
                          {highlightLabel(item.label, autocompleteQuery)}
                        </span>
                        <span className="autocomplete-item-desc">
                          {item.desc}
                        </span>
                      </button>
                    ))}
                  </div>
                );
              })()}
            <textarea
              value={prompt}
              onChange={(e) => handleTextChange(e.target.value)}
              placeholder="Describe what you want to build..."
              rows={3}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div className="dock-footer">
            {isStreaming ? (
              <button
                className="titlebar-action danger dock-send-btn"
                type="button"
                onClick={onStopStreaming}
              >
                <Square size={13} />
                <span>Stop</span>
              </button>
            ) : (
              <button
                className="titlebar-action primary dock-send-btn"
                type="button"
                onClick={onSubmit}
              >
                {submitting ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Play size={16} />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="dock-tray">
        <div className="dock-tray-selectors">
          <div className="dock-dropdown">
            <button
              className="dock-dropdown-trigger mode-trigger"
              type="button"
              onClick={() => onModeChange(mode === "build" ? "plan" : "build")}
            >
              <span>{mode === "build" ? "Build" : "Plan"}</span>
            </button>
          </div>
          <span className="dock-tray-sep">/</span>
          <div className="dock-dropdown" ref={modelDropdownRef}>
            <button
              className="dock-dropdown-trigger"
              type="button"
              onClick={() => setShowModelDropdown(!showModelDropdown)}
            >
              <span>
                {provider && model
                  ? `${provider}: ${prettifyModelId(model)}`
                  : "Select model"}
              </span>
              <ChevronDown size={12} />
            </button>
            {showModelDropdown && (
              <div className="dock-dropdown-menu model-menu unified-model-menu">
                <div className="dock-dropdown-search">
                  <Search size={12} />
                  <input
                    type="text"
                    placeholder="Search models..."
                    value={modelSearchQuery}
                    onChange={(e) => setModelSearchQuery(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="dock-dropdown-items">
                  {filteredModels.length === 0 ? (
                    <div className="dock-dropdown-empty">No models found</div>
                  ) : (
                    Object.entries(groupedByProvider).map(
                      ([providerName, items]) => (
                        <div key={providerName} className="dock-dropdown-group">
                          <div className="dock-dropdown-group-header">
                            {providerName}
                          </div>
                          {items.map((item) => (
                            <button
                              key={item.model}
                              className={`dock-dropdown-item${model === item.model && provider === item.provider ? " active" : ""}`}
                              type="button"
                              onClick={() => {
                                localStorage.setItem("ac:model", item.model);
                                localStorage.setItem(
                                  "ac:provider",
                                  item.provider,
                                );
                                setShowModelDropdown(false);
                              }}
                            >
                              <span>{prettifyModelId(item.model)}</span>
                              {getModelContextLabel(
                                item.model,
                                modelContextLimits,
                              ) && (
                                <span className="dock-dropdown-context-badge">
                                  {getModelContextLabel(
                                    item.model,
                                    modelContextLimits,
                                  )}
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                      ),
                    )
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="dock-tray-usage">
          {hasUsage && (
            <div className="dock-tray-context" title={usage.details}>
              {usage.usagePercent !== null ? (
                <>
                  <div className="context-bar">
                    <div
                      className="context-bar-fill"
                      style={{
                        width: `${barPercent}%`,
                        backgroundColor: barColor,
                      }}
                    />
                  </div>
                  <span className="context-bar-label">{usage.usageLabel}</span>
                </>
              ) : (
                <span className="context-bar-label">{usage.usageLabel}</span>
              )}
            </div>
          )}
          {sessionDetail && contextUsed > 0 && (
            <div
              className="dock-tray-session-context"
              title={`Context: ${formatTokens(contextUsed)} / ${formatTokens(modelMaxContext)}`}
            >
              <div className="context-bar">
                <div
                  className="context-bar-fill"
                  style={{
                    width: `${contextPercent}%`,
                    backgroundColor: contextColor,
                  }}
                />
              </div>
              <span className="context-bar-label">
                {formatTokens(contextUsed)} / {formatTokens(modelMaxContext)}
              </span>
            </div>
          )}
          {sessionDetail ? (
            <span
              className="dock-tray-requests"
              title={`${sessionUsage.requestCount} requests`}
            >
              <Zap size={11} />
              {sessionUsage.requestCount} req
              {sessionUsage.requestCount !== 1 ? "s" : ""}
              {sessionUsage.totalTokens > 0
                ? ` · ${formatTokens(sessionUsage.totalTokens)}`
                : ""}
            </span>
          ) : (
            <span className="dock-tray-no-session">No session</span>
          )}
        </div>
      </div>
    </div>
  );
}
