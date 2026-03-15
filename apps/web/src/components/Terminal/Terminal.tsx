import {
  TerminalSquare,
  FileDiff,
  Bot,
  LoaderCircle,
  Copy,
  X,
} from "lucide-react";
import type { SessionDetail } from "@alpha-code/shared";
import "./Terminal.scss";

type DockTab = "terminal" | "changes" | "activity";

interface FileItem {
  id: string;
  path: string;
  name: string;
  content: string;
  language: string;
}

interface TerminalPanelProps {
  show: boolean;
  dockTab: DockTab;
  onTabChange: (tab: DockTab) => void;
  xtermReady: boolean;
  xtermContainerRef: React.RefObject<HTMLDivElement | null>;
  sessionDetail: SessionDetail | null;
  changedFiles: FileItem[];
  onFileClick: (fileId: string) => void;
  onCopyTerminal: () => void;
  onClose: () => void;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function TerminalPanel({
  show,
  dockTab,
  onTabChange,
  xtermReady,
  xtermContainerRef,
  sessionDetail,
  changedFiles,
  onFileClick,
  onCopyTerminal,
  onClose,
}: TerminalPanelProps) {
  if (!show) return null;

  return (
    <section className="terminal-area">
      <div className="terminal-header">
        <div className="terminal-tabs">
          <button
            className={`terminal-tab${dockTab === "terminal" ? " active" : ""}`}
            type="button"
            onClick={() => onTabChange("terminal")}
          >
            <TerminalSquare size={13} />
            <span>Terminal</span>
          </button>
          <button
            className={`terminal-tab${dockTab === "changes" ? " active" : ""}`}
            type="button"
            onClick={() => onTabChange("changes")}
          >
            <FileDiff size={13} />
            <span>Changes</span>
          </button>
          <button
            className={`terminal-tab${dockTab === "activity" ? " active" : ""}`}
            type="button"
            onClick={() => onTabChange("activity")}
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
              onClick={onCopyTerminal}
            >
              <Copy size={12} />
            </button>
            <button
              className="toggle-panel-btn"
              type="button"
              onClick={onClose}
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
        {dockTab === "changes" && (
          <div className="terminal-body-scroll compact-scroll">
            {changedFiles.length === 0 ? (
              <p className="empty-inline">No unsaved files.</p>
            ) : (
              <div className="changes-grid">
                {changedFiles.map((file) => (
                  <button
                    key={file.id}
                    className="change-row"
                    type="button"
                    onClick={() => onFileClick(file.id)}
                  >
                    <strong>{file.name}</strong>
                    <span>{file.path}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {dockTab === "activity" && (
          <div className="terminal-body-scroll compact-scroll">
            {sessionDetail ? (
              <div className="activity-list">
                {sessionDetail.messages
                  .filter((m) => m.role === "system")
                  .map((message) => (
                    <article key={message.id} className="activity-row">
                      <span>{message.content}</span>
                      <small>{formatTime(message.createdAt)}</small>
                    </article>
                  ))}
              </div>
            ) : (
              <p className="empty-inline">
                Session activity appears after you start a thread.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
