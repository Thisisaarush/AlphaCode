import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import {
  Sparkles,
  Plus,
  Terminal,
  Files,
  Settings2,
  ChevronDown,
  LoaderCircle,
  Wrench,
  Check,
  CircleAlert,
  Copy,
  RotateCcw,
} from "lucide-react";
import type {
  SessionDetail,
  SessionMessage,
  FileChange,
} from "@alpha-code/shared";
import "./MessageTimeline.scss";

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface MessageTimelineProps {
  sessionDetail: SessionDetail | null;
  streamingContent: string;
  streamingStatusLabel: string | null;
  activeToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    arguments?: string;
    result?: string;
    isError?: boolean;
    fileChange?: FileChange;
    status: "running" | "done" | "error";
  }>;
  model: string;
  mode: "plan" | "build";
  onSubmitPrompt: () => void;
  onStopStreaming: () => void;
  onRestoreCheckpoint: (messageId: string) => void;
  onNewSession: () => void;
  onOpenTerminal: () => void;
  onOpenEditor: () => void;
  onOpenSettings: () => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  showScrollButton: boolean;
  onScrollToBottom: () => void;
  onSessionSelect: (id: string) => void;
  isStreaming: boolean;
  submitting: boolean;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
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
  if (known[raw]) return known[raw];
  if (raw.includes("/")) {
    const parts = raw.split("/");
    const modelPart = parts[parts.length - 1] ?? raw;
    return prettifyModelId(modelPart);
  }
  if (stripped.startsWith("claude-")) {
    return stripped
      .replace("claude-", "Claude ")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/\s+/g, " ")
      .trim();
  }
  if (stripped.startsWith("gemini-")) {
    return stripped
      .replace("gemini-", "Gemini ")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/\s+/g, " ")
      .trim();
  }
  return stripped
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

interface CheckpointPair {
  userMessage: SessionMessage;
  responseMessages: SessionMessage[];
  fileChanges: FileChange[];
}

function computeCheckpointPairs(
  sessionDetail: SessionDetail,
): CheckpointPair[] {
  const pairs: CheckpointPair[] = [];
  const msgs = sessionDetail.messages;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "user") {
      const userMsg = msgs[i];
      const responseMessages: SessionMessage[] = [];
      const fileChanges: FileChange[] = [];
      let j = i + 1;
      while (j < msgs.length && msgs[j].role !== "user") {
        responseMessages.push(msgs[j]);
        if (msgs[j].fileChanges) {
          fileChanges.push(...msgs[j].fileChanges!);
        }
        j++;
      }
      pairs.push({ userMessage: userMsg, responseMessages, fileChanges });
    }
  }
  return pairs;
}

function CodeBlock(props: { children?: React.ReactNode }) {
  const { children } = props;
  return (
    <div className="md-code-block">
      <button
        className="md-code-copy"
        onClick={(e) => {
          const code =
            (
              e.currentTarget.parentElement?.querySelector(
                "code",
              ) as HTMLElement | null
            )?.innerText ?? "";
          navigator.clipboard.writeText(code);
          const btn = e.currentTarget;
          btn.textContent = "Copied!";
          setTimeout(() => {
            btn.textContent = "Copy";
          }, 1500);
        }}
      >
        Copy
      </button>
      <pre>{children}</pre>
    </div>
  );
}

export function MessageTimeline({
  sessionDetail,
  streamingContent,
  streamingStatusLabel,
  activeToolCalls,
  model,
  mode,
  onSubmitPrompt,
  onStopStreaming,
  onRestoreCheckpoint,
  onNewSession,
  onOpenTerminal,
  onOpenEditor,
  onOpenSettings,
  scrollRef,
  showScrollButton,
  onScrollToBottom,
  isStreaming,
  submitting,
}: MessageTimelineProps) {
  const checkpointPairs = sessionDetail
    ? computeCheckpointPairs(sessionDetail)
    : [];

  return (
    <div className="session-view">
      <div className="message-timeline compact-scroll" ref={scrollRef}>
        {sessionDetail ? (
          <>
            {checkpointPairs.map((pair, pairIdx) => {
              const assistantMessages = pair.responseMessages.filter(
                (m) => m.role === "assistant",
              );
              const toolMessages = pair.responseMessages.filter(
                (m) => m.role === "tool",
              );

              const toolResultsMap: Record<
                string,
                { result: string; isError?: boolean }
              > = {};
              for (const tm of toolMessages) {
                if (tm.toolCallId) {
                  toolResultsMap[tm.toolCallId] = {
                    result: tm.content,
                    isError: tm.isError,
                  };
                }
              }

              const allToolCalls = assistantMessages.flatMap(
                (m) => m.toolCalls || [],
              );
              const finalAssistant = [...assistantMessages]
                .reverse()
                .find((m) => m.content.trim());
              const responseDuration = finalAssistant
                ? new Date(finalAssistant.createdAt).getTime() -
                  new Date(pair.userMessage.createdAt).getTime()
                : null;

              return (
                <div key={pair.userMessage.id} className="checkpoint-pair">
                  <article className="message-turn user">
                    <div className="message-content">
                      <pre>{pair.userMessage.content}</pre>
                    </div>
                    <div className="message-meta message-meta-footer">
                      <div className="message-meta-row">
                        <span className="message-mode">{mode}</span>
                        <span className="message-time">
                          {formatTime(pair.userMessage.createdAt)}
                        </span>
                        <span className="message-info">
                          {prettifyModelId(model)}
                        </span>
                        <div className="message-actions-inline">
                          <button
                            className="message-action-btn"
                            type="button"
                            title="Restore checkpoint"
                            onClick={() =>
                              onRestoreCheckpoint(pair.userMessage.id)
                            }
                          >
                            <RotateCcw size={12} />
                          </button>
                          <button
                            className="message-action-btn"
                            type="button"
                            title="Copy message"
                            onClick={() =>
                              navigator.clipboard.writeText(
                                pair.userMessage.content,
                              )
                            }
                          >
                            <Copy size={12} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>

                  {allToolCalls.length > 0 && (
                    <div className="tool-calls-container">
                      {allToolCalls.map((tc) => {
                        const tr = toolResultsMap[tc.id];
                        let parsedArgs: Record<string, unknown> = {};
                        try {
                          parsedArgs = JSON.parse(tc.arguments);
                        } catch {}
                        const filePath = parsedArgs.path as string | undefined;
                        const toolLabel =
                          tc.name === "run_command"
                            ? `$ ${(parsedArgs.command as string) || tc.name}`
                            : tc.name === "read_file"
                              ? `Read ${filePath || ""}`
                              : tc.name === "write_file"
                                ? `Write ${filePath || ""}`
                                : tc.name === "list_files"
                                  ? `List ${filePath || "."}`
                                  : tc.name;

                        const fc = pair.fileChanges.find(
                          (f) => f.toolCallId === tc.id,
                        );

                        return (
                          <details
                            key={tc.id}
                            className={`tool-call-block ${tr?.isError ? "error" : "done"}`}
                          >
                            <summary className="tool-call-header">
                              <Wrench size={13} />
                              <span className="tool-call-name">
                                {toolLabel}
                              </span>
                              {fc && (
                                <span className="file-change-stats">
                                  <span className="lines-added">
                                    +{fc.linesAdded}
                                  </span>
                                  <span className="lines-deleted">
                                    -{fc.linesDeleted}
                                  </span>
                                </span>
                              )}
                              {tr?.isError ? (
                                <span className="tool-call-status error">
                                  <CircleAlert size={11} /> error
                                </span>
                              ) : (
                                <span className="tool-call-status done">
                                  <Check size={11} /> done
                                </span>
                              )}
                            </summary>
                            {tr && (
                              <pre className="tool-call-output">
                                {tr.result}
                              </pre>
                            )}
                          </details>
                        );
                      })}
                    </div>
                  )}

                  {finalAssistant && finalAssistant.content && (
                    <article className="message-turn assistant">
                      <div className="message-content">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          rehypePlugins={[rehypeHighlight]}
                          components={{ pre: CodeBlock }}
                        >
                          {finalAssistant.content}
                        </ReactMarkdown>
                      </div>
                      <div className="message-meta message-meta-footer">
                        <button
                          className="message-action-btn"
                          type="button"
                          title="Copy message"
                          onClick={() =>
                            navigator.clipboard.writeText(
                              finalAssistant.content,
                            )
                          }
                        >
                          <Copy size={12} />
                        </button>
                        <span className="message-mode">{mode}</span>
                        <span className="message-time">
                          {formatTime(finalAssistant.createdAt)}
                        </span>
                        <span className="message-info">
                          {prettifyModelId(model)}
                        </span>
                        {responseDuration && (
                          <span className="message-duration">
                            {formatDuration(responseDuration)}
                          </span>
                        )}
                      </div>
                    </article>
                  )}

                  {pairIdx < checkpointPairs.length - 1 && (
                    <div className="checkpoint-separator" />
                  )}
                </div>
              );
            })}

            {streamingStatusLabel && !streamingContent && (
              <div className="streaming-status-indicator">
                <LoaderCircle size={14} className="spin" />
                <span>{streamingStatusLabel}</span>
              </div>
            )}

            {activeToolCalls.length > 0 && (
              <div className="tool-calls-container streaming">
                {activeToolCalls.map((tc) => {
                  let parsedArgs: Record<string, unknown> = {};
                  try {
                    parsedArgs = JSON.parse(tc.arguments || "{}");
                  } catch {}
                  const filePath = parsedArgs.path as string | undefined;
                  const toolLabel =
                    tc.toolName === "run_command"
                      ? `$ ${(parsedArgs.command as string) || tc.toolName}`
                      : tc.toolName === "read_file"
                        ? `Read ${filePath || ""}`
                        : tc.toolName === "write_file"
                          ? `Write ${filePath || ""}`
                          : tc.toolName === "list_files"
                            ? `List ${filePath || "."}`
                            : tc.toolName;
                  return (
                    <details
                      key={tc.toolCallId}
                      className={`tool-call-block ${tc.status}`}
                      open={tc.status === "running"}
                    >
                      <summary className="tool-call-header">
                        {tc.status === "running" ? (
                          <LoaderCircle size={13} className="spin" />
                        ) : (
                          <Wrench size={13} />
                        )}
                        <span className="tool-call-name">{toolLabel}</span>
                        {tc.fileChange && (
                          <span className="file-change-stats">
                            <span className="lines-added">
                              +{tc.fileChange.linesAdded}
                            </span>
                            <span className="lines-deleted">
                              -{tc.fileChange.linesDeleted}
                            </span>
                          </span>
                        )}
                        {tc.status === "running" && (
                          <span className="tool-call-status running">
                            running
                          </span>
                        )}
                        {tc.status === "done" && (
                          <span className="tool-call-status done">
                            <Check size={11} /> done
                          </span>
                        )}
                        {tc.status === "error" && (
                          <span className="tool-call-status error">
                            <CircleAlert size={11} /> error
                          </span>
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
                    components={{ pre: CodeBlock }}
                  >
                    {streamingContent}
                  </ReactMarkdown>
                </div>
              </article>
            )}
            <div />
          </>
        ) : (
          <div className="empty-state">
            <div className="welcome-hero">
              <Sparkles size={28} className="welcome-icon" />
              <h2 className="welcome-title">Alpha Code</h2>
              <p className="welcome-subtitle">
                AI-powered code editor. Ask questions, run commands, and edit
                files — all in one place.
              </p>
            </div>
            <div className="welcome-actions">
              <button
                className="welcome-card"
                type="button"
                onClick={onNewSession}
              >
                <Plus size={16} />
                <div>
                  <strong>New Session</strong>
                  <span>Start a conversation with AI</span>
                </div>
              </button>
              <button
                className="welcome-card"
                type="button"
                onClick={onOpenTerminal}
              >
                <Terminal size={16} />
                <div>
                  <strong>Open Terminal</strong>
                  <span>Run commands in your project</span>
                </div>
              </button>
              <button
                className="welcome-card"
                type="button"
                onClick={onOpenEditor}
              >
                <Files size={16} />
                <div>
                  <strong>Browse Files</strong>
                  <span>Explore your project tree</span>
                </div>
              </button>
              <button
                className="welcome-card"
                type="button"
                onClick={onOpenSettings}
              >
                <Settings2 size={16} />
                <div>
                  <strong>Settings</strong>
                  <span>Configure AI providers</span>
                </div>
              </button>
            </div>
            <div className="welcome-shortcuts">
              <span>
                <kbd>⌘K</kbd> Search
              </span>
              <span>
                <kbd>⌘N</kbd> New Session
              </span>
              <span>
                <kbd>⌘S</kbd> Save File
              </span>
              <span>
                <kbd>↩</kbd> Send Message
              </span>
            </div>
          </div>
        )}
      </div>

      {showScrollButton && sessionDetail && (
        <button
          className="scroll-to-bottom-btn"
          type="button"
          onClick={onScrollToBottom}
          title="Scroll to bottom"
        >
          <ChevronDown size={16} />
        </button>
      )}
    </div>
  );
}
