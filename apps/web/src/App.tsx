import { useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bot,
  ChevronDown,
  Files,
  Folder,
  FolderGit2,
  GitBranch,
  MessageSquare,
  PanelBottom,
  Play,
  Search,
  Settings2,
  Terminal,
  X
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { APP_NAME } from "@alpha-code/shared";

type FileItem = {
  id: string;
  name: string;
  path: string;
  language: string;
  folder: string;
  content: string;
};

type ProviderItem = {
  id: string;
  label: string;
  status: string;
  model: string;
};

type WorkspaceSnapshot = {
  workspace: {
    id: string;
    name: string;
    root: string;
    files: FileItem[];
  };
  sessions: Array<{
    id: string;
    title: string;
    status: string;
    provider: string;
    model: string;
    updatedAt: string;
  }>;
  suggestions: Array<{
    id: string;
    label: string;
  }>;
  providers: ProviderItem[];
};

const railItems = [Files, Search, FolderGit2, MessageSquare, PanelBottom, Settings2];
const serverUrl = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3030";

export default function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [activeFileId, setActiveFileId] = useState("");
  const [openFileIds, setOpenFileIds] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [provider, setProvider] = useState("GitHub");
  const [model, setModel] = useState("Auto");
  const [dockTab, setDockTab] = useState<"terminal" | "changes" | "output">("terminal");
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function loadWorkspace() {
      setLoading(true);
      const response = await fetch(`${serverUrl}/api/workspace`);
      const payload = (await response.json()) as WorkspaceSnapshot;

      setSnapshot(payload);
      setDrafts(
        Object.fromEntries(payload.workspace.files.map((file) => [file.id, file.content]))
      );

      const firstFile = payload.workspace.files[0];
      if (firstFile) {
        setActiveFileId(firstFile.id);
        setOpenFileIds([firstFile.id]);
      }

      const firstProvider = payload.providers[0];
      if (firstProvider) {
        setProvider(firstProvider.label);
        setModel(firstProvider.model);
      }

      setLoading(false);
    }

    void loadWorkspace();
  }, []);

  const files = snapshot?.workspace.files ?? [];
  const groups = [
    {
      label: "apps",
      items: files.filter((file) => file.path.startsWith("apps/"))
    },
    {
      label: "packages",
      items: files.filter((file) => file.path.startsWith("packages/"))
    }
  ].filter((group) => group.items.length > 0);

  const providerOptions = snapshot?.providers.map((item) => item.label) ?? [];
  const modelOptions = ["Auto", "Claude Sonnet 4", "GPT-5", "Kimi K2"];

  const activeFile = files.find((file) => file.id === activeFileId) ?? files[0];
  const openFiles = openFileIds
    .map((fileId) => files.find((file) => file.id === fileId))
    .filter((file): file is FileItem => Boolean(file));

  const changedFiles = useMemo(
    () => files.filter((file) => drafts[file.id] !== file.content),
    [drafts]
  );

  async function saveActiveFile() {
    if (!activeFile) {
      return;
    }

    setSaving(true);
    await fetch(`${serverUrl}/api/file`, {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        path: activeFile.path,
        content: drafts[activeFile.id] ?? activeFile.content
      })
    });

    const response = await fetch(`${serverUrl}/api/workspace`);
    const payload = (await response.json()) as WorkspaceSnapshot;
    setSnapshot(payload);
    setSaving(false);
  }

  const openFile = (fileId: string) => {
    setOpenFileIds((current) =>
      current.includes(fileId) ? current : [...current, fileId]
    );
    setActiveFileId(fileId);
  };

  const closeFile = (fileId: string) => {
    setOpenFileIds((current) => current.filter((item) => item !== fileId));
    if (activeFileId === fileId) {
      const nextId = openFiles.find((file) => file.id !== fileId)?.id ?? files[0].id;
      setActiveFileId(nextId);
    }
  };

  if (loading || !snapshot || !activeFile) {
    return (
      <main className="loading-shell">
        <div className="loading-panel">
          <span className="brand-dot" />
          <strong>{APP_NAME}</strong>
          <p>Connecting workspace</p>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand-lockup">
            <span className="brand-dot" />
            <strong>{APP_NAME}</strong>
          </div>

          <div className="workspace-badge">
            <Folder size={14} />
            <span>{snapshot.workspace.name}</span>
          </div>

          <div className="workspace-badge">
            <GitBranch size={14} />
            <span>main</span>
          </div>
        </div>

        <div className="topbar-right">
          <label className="topbar-select">
            <span>Provider</span>
            <select value={provider} onChange={(event) => setProvider(event.target.value)}>
              {providerOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label className="topbar-select">
            <span>Model</span>
            <select value={model} onChange={(event) => setModel(event.target.value)}>
                {modelOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <button className="run-button" type="button">
            <Play size={14} />
            <span>Run</span>
          </button>
        </div>
      </header>

      <PanelGroup autoSaveId="alpha-code-shell" className="layout-shell" direction="horizontal">
        <Panel defaultSize={21} minSize={16} className="explorer-wrapper">
          <div className="side-layout">
            <nav className="icon-rail" aria-label="Primary navigation">
              {railItems.map((Icon, index) => (
                <button
                  key={index}
                  className={`rail-button${index === 0 ? " rail-button-active" : ""}`}
                  type="button"
                >
                  <Icon size={16} />
                </button>
              ))}
            </nav>

            <section className="explorer-panel">
              <div className="panel-titlebar">
                <div>
                  <span className="panel-eyebrow">Explorer</span>
                  <h2>Workspace</h2>
                </div>
                <button className="titlebar-action" type="button">
                  <Search size={14} />
                </button>
              </div>

              <div className="explorer-scroll">
                {groups.map((group) => (
                  <section className="tree-group" key={group.label}>
                    <button className="tree-folder" type="button">
                      <ChevronDown size={14} />
                    <span>{group.label}</span>
                    </button>

                    <div className="tree-items">
                      {group.items.map((file) => {
                        const active = file.id === activeFile.id;
                        const dirty = changedFiles.some((changedFile) => changedFile.id === file.id);

                        return (
                          <button
                            key={file.id}
                            className={`tree-file${active ? " tree-file-active" : ""}`}
                            onClick={() => openFile(file.id)}
                            type="button"
                          >
                            <span className="tree-file-name">{file.path.replace(`${group.label}/`, "")}</span>
                            {dirty ? <span className="dirty-dot" /> : null}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </section>
          </div>
        </Panel>

        <PanelResizeHandle className="resize-handle resize-handle-vertical" />

        <Panel minSize={38} className="center-wrapper">
          <PanelGroup autoSaveId="alpha-code-center" direction="vertical">
            <Panel defaultSize={74} minSize={44} className="editor-wrapper">
              <section className="editor-panel">
                <div className="editor-toolbar">
                  <div className="breadcrumbs">
                    <span>workspace</span>
                    <span>{activeFile.folder}</span>
                    <strong>{activeFile.name}</strong>
                  </div>
                  <div className="editor-actions">
                    <button className="titlebar-action" type="button">
                      <Files size={14} />
                    </button>
                  </div>
                </div>

                <div className="tabs-strip">
                  <AnimatePresence initial={false}>
                    {openFiles.map((file) => {
                      const active = file.id === activeFile.id;
                      const dirty = changedFiles.some((changedFile) => changedFile.id === file.id);

                      return (
                        <motion.button
                          key={file.id}
                          layout
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          transition={{ duration: 0.18 }}
                          className={`tab-chip${active ? " tab-chip-active" : ""}`}
                          onClick={() => setActiveFileId(file.id)}
                          type="button"
                        >
                          <span>{file.name}</span>
                          {dirty ? <span className="dirty-dot" /> : null}
                          {openFiles.length > 1 ? (
                            <span
                              className="tab-close"
                              onClick={(event) => {
                                event.stopPropagation();
                                closeFile(file.id);
                              }}
                            >
                              <X size={12} />
                            </span>
                          ) : null}
                        </motion.button>
                      );
                    })}
                  </AnimatePresence>
                </div>

                <div className="editor-surface">
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
                      smoothScrolling: true,
                      automaticLayout: true,
                      scrollBeyondLastLine: false,
                      roundedSelection: false,
                      wordWrap: "off",
                      padding: { top: 16 }
                    }}
                  />
                </div>

                <div className="editor-footer">
                  <span>{activeFile.path}</span>
                  <button className="save-button" onClick={() => void saveActiveFile()} type="button">
                    {saving ? "Saving..." : "Save"}
                  </button>
                </div>
              </section>
            </Panel>

            <PanelResizeHandle className="resize-handle resize-handle-horizontal" />

            <Panel defaultSize={26} minSize={18} className="dock-wrapper">
              <section className="dock-panel">
                <div className="dock-tabs">
                  <button
                    className={`dock-tab${dockTab === "terminal" ? " dock-tab-active" : ""}`}
                    onClick={() => setDockTab("terminal")}
                    type="button"
                  >
                    <Terminal size={14} />
                    <span>Terminal</span>
                  </button>
                  <button
                    className={`dock-tab${dockTab === "changes" ? " dock-tab-active" : ""}`}
                    onClick={() => setDockTab("changes")}
                    type="button"
                  >
                    <FolderGit2 size={14} />
                    <span>Changes</span>
                  </button>
                  <button
                    className={`dock-tab${dockTab === "output" ? " dock-tab-active" : ""}`}
                    onClick={() => setDockTab("output")}
                    type="button"
                  >
                    <Bot size={14} />
                    <span>Output</span>
                  </button>
                </div>

                <div className="dock-content">
                  {dockTab === "terminal" ? (
                    <div className="terminal-view">
                      <span className="terminal-prompt">$</span>
                      <span className="terminal-placeholder">Waiting for runtime connection</span>
                    </div>
                  ) : null}

                  {dockTab === "changes" ? (
                    <div className="changes-list">
                      {changedFiles.length === 0 ? (
                        <p className="empty-copy">No unsaved changes</p>
                      ) : (
                        changedFiles.map((file) => (
                          <article className="change-item" key={file.id}>
                            <strong>{file.name}</strong>
                            <span>{file.path}</span>
                          </article>
                        ))
                      )}
                    </div>
                  ) : null}

                  {dockTab === "output" ? (
                    <div className="output-view">
                      <p className="empty-copy">No active task output</p>
                    </div>
                  ) : null}
                </div>
              </section>
            </Panel>
          </PanelGroup>
        </Panel>

        <PanelResizeHandle className="resize-handle resize-handle-vertical" />

        <Panel defaultSize={26} minSize={20} className="assistant-wrapper">
          <section className="assistant-panel">
            <div className="panel-titlebar">
              <div>
                <span className="panel-eyebrow">Agent</span>
                <h2>Session</h2>
              </div>
              <button className="titlebar-action" type="button">
                <MessageSquare size={14} />
              </button>
            </div>

            <div className="session-header">
              <div className="workspace-badge workspace-badge-quiet">
                <Bot size={14} />
                <span>{provider}</span>
              </div>
              <div className="workspace-badge workspace-badge-quiet">
                <span>{model}</span>
              </div>
            </div>

            <div className="conversation-panel">
              <div className="empty-thread">
                <Bot size={18} />
                <strong>No active session</strong>
                <p>Choose context and start a task.</p>
              </div>
            </div>

            <div className="context-strip">
              <span className="context-chip">@file</span>
              <span className="context-chip">@selection</span>
              <span className="context-chip">@terminal</span>
            </div>

            <div className="composer">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Ask Alpha Code"
                rows={4}
              />

              <div className="composer-actions">
                <button className="attach-button" type="button">
                  Attach
                </button>
                <button className="send-button" type="button">
                  Send
                </button>
              </div>
            </div>
          </section>
        </Panel>
      </PanelGroup>
    </main>
  );
}
