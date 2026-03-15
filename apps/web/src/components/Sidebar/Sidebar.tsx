import {
  MessageSquare,
  FolderGit2,
  Sparkles,
  Trash2,
  ExternalLink,
  LogOut,
  FileDiff,
  Settings2,
} from "lucide-react";
import type { SessionDetail, WorkspaceSnapshot } from "@alpha-code/shared";
import "./Sidebar.scss";

type SidebarTab = "chat" | "git";

interface Session {
  id: string;
  title: string;
  provider: string;
  updatedAt: string;
  status: "running" | "review" | "idle";
  sharedId?: string;
}

interface FileChange {
  id: string;
  path: string;
  name: string;
}

interface SidebarProps {
  show: boolean;
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  sessions: Session[];
  activeSessionId: string;
  onSessionSelect: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
  onShareSession: (id: string) => void;
  onUnshareSession: (shareId: string) => void;
  onSettingsToggle: () => void;
  terminalRunCount: number;
  changedFiles: FileChange[];
  onFileClick: (fileId: string) => void;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

const railItems: Array<{
  key: SidebarTab;
  icon: typeof MessageSquare;
  label: string;
}> = [
  { key: "chat", icon: MessageSquare, label: "Threads" },
  { key: "git", icon: FolderGit2, label: "Changes" },
];

export function Sidebar({
  show,
  activeTab,
  onTabChange,
  sessions,
  activeSessionId,
  onSessionSelect,
  onNewSession,
  onDeleteSession,
  onShareSession,
  onUnshareSession,
  onSettingsToggle,
  terminalRunCount,
  changedFiles,
  onFileClick,
}: SidebarProps) {
  return (
    <div className={`sidebar-layout${show ? "" : " collapsed"}`}>
      <aside className="sidebar-rail">
        {railItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              className={`rail-button${activeTab === item.key ? " active" : ""}`}
              type="button"
              title={item.label}
              onClick={() => onTabChange(item.key)}
            >
              <Icon size={16} />
            </button>
          );
        })}
        <div className="rail-spacer" />
        <button
          className="rail-button"
          type="button"
          title="Settings"
          onClick={onSettingsToggle}
        >
          <Settings2 size={16} />
        </button>
      </aside>

      {show ? (
        <section className="sidebar-panel">
          {activeTab === "chat" ? (
            <>
              <div className="pane-header">
                <div>
                  <span className="pane-kicker">Threads</span>
                  <h2>Sessions</h2>
                </div>
                <button
                  className="pane-button accent"
                  type="button"
                  onClick={onNewSession}
                >
                  <Sparkles size={12} />
                  <span>New</span>
                </button>
              </div>

              <div className="session-list compact-scroll">
                {sessions.length === 0 ? (
                  <div className="empty-inline">No sessions yet</div>
                ) : (
                  sessions.map((session) => (
                    <div
                      key={session.id}
                      className={`session-row${activeSessionId === session.id ? " active" : ""}`}
                    >
                      <button
                        className="session-row-main"
                        type="button"
                        onClick={() => onSessionSelect(session.id)}
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
                          onDeleteSession(session.id);
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                      <button
                        className="session-share-btn"
                        type="button"
                        title={
                          session.sharedId ? "Unshare session" : "Share session"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          if (session.sharedId) {
                            onUnshareSession(session.sharedId);
                          } else {
                            onShareSession(session.id);
                          }
                        }}
                      >
                        {session.sharedId ? (
                          <LogOut size={12} />
                        ) : (
                          <ExternalLink size={12} />
                        )}
                      </button>
                    </div>
                  ))
                )}
              </div>

              <div className="sidebar-footer-note">
                <span>Recent runs</span>
                <strong>{terminalRunCount}</strong>
              </div>
            </>
          ) : null}

          {activeTab === "git" ? (
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
                    <button
                      key={file.id}
                      className="change-card"
                      type="button"
                      onClick={() => onFileClick(file.id)}
                    >
                      <FileDiff size={13} />
                      <span>{file.path}</span>
                    </button>
                  ))
                )}
              </div>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
