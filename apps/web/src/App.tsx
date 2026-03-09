import { useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import { AnimatePresence, motion } from "framer-motion";
import { APP_NAME } from "@alpha-code/shared";

type FileNode = {
  id: string;
  name: string;
  path: string;
  language: string;
  content: string;
};

type Workspace = {
  id: string;
  name: string;
  root: string;
  files: FileNode[];
};

const workspaces: Workspace[] = [
  {
    id: "alpha",
    name: "Alpha Code",
    root: "/Users/aarushtanwar/Developer/alpha-code",
    files: [
      {
        id: "app-shell",
        name: "App.tsx",
        path: "apps/web/src/App.tsx",
        language: "typescript",
        content: `export function AppShell() {\n  return {\n    workspace: \"Alpha Code\",\n    focus: \"GitHub-first coding workflows\",\n  };\n}`
      },
      {
        id: "roadmap",
        name: "roadmap.md",
        path: "docs/roadmap/mvp.md",
        language: "markdown",
        content: `# Alpha Code MVP\n\n- Workspace picker\n- Monaco editor shell\n- GitHub-backed model discovery\n- Chat, terminal, and diff workflow\n`
      },
      {
        id: "server",
        name: "index.ts",
        path: "apps/server/src/index.ts",
        language: "typescript",
        content: `export const bootServer = () => {\n  return \"server scaffold running\";\n};`
      }
    ]
  },
  {
    id: "playground",
    name: "GitHub Sandbox",
    root: "/Users/aarushtanwar/Developer/github-sandbox",
    files: [
      {
        id: "copilot",
        name: "github.ts",
        path: "src/providers/github.ts",
        language: "typescript",
        content: `export const githubProvider = {\n  status: \"connect-github\",\n  supportsModelPicker: true,\n  experimentalCopilot: true,\n};`
      },
      {
        id: "notes",
        name: "notes.md",
        path: "notes/integration.md",
        language: "markdown",
        content: `## GitHub-first roadmap\n\n1. Connect account\n2. Discover available models\n3. Bind model to coding session\n4. Add Copilot experimental path\n`
      }
    ]
  }
];

const activityItems = [
  "Workspace selection with persisted tabs",
  "File explorer shell ready for real filesystem wiring",
  "Monaco editor integrated for VS Code-like editing",
  "Smooth pane motion prepared for chat and terminal surfaces"
];

export default function App() {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0].id);
  const workspace = useMemo(
    () => workspaces.find((item) => item.id === workspaceId) ?? workspaces[0],
    [workspaceId]
  );
  const [openFileIds, setOpenFileIds] = useState<string[]>([
    workspace.files[0]?.id ?? ""
  ]);
  const [activeFileId, setActiveFileId] = useState(workspace.files[0]?.id ?? "");
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      workspaces.flatMap((item) => item.files.map((file) => [file.id, file.content]))
    )
  );

  const openFiles = workspace.files.filter((file) => openFileIds.includes(file.id));
  const activeFile =
    workspace.files.find((file) => file.id === activeFileId) ?? workspace.files[0];

  const openFile = (fileId: string) => {
    setOpenFileIds((current) =>
      current.includes(fileId) ? current : [...current, fileId]
    );
    setActiveFileId(fileId);
  };

  const closeFile = (fileId: string) => {
    setOpenFileIds((current) => current.filter((item) => item !== fileId));
    if (activeFileId === fileId) {
      const nextFile = openFiles.find((file) => file.id !== fileId) ?? workspace.files[0];
      setActiveFileId(nextFile?.id ?? "");
    }
  };

  return (
    <main className="workspace-shell">
      <motion.header
        className="topbar"
        initial={{ opacity: 0, y: -24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
      >
        <div>
          <p className="eyebrow">Phase 2</p>
          <h1>{APP_NAME}</h1>
        </div>

        <div className="workspace-switcher">
          <label htmlFor="workspace-select">Workspace</label>
          <select
            id="workspace-select"
            value={workspace.id}
            onChange={(event) => {
              const nextId = event.target.value;
              const nextWorkspace =
                workspaces.find((item) => item.id === nextId) ?? workspaces[0];
              setWorkspaceId(nextWorkspace.id);
              setOpenFileIds([nextWorkspace.files[0]?.id ?? ""]);
              setActiveFileId(nextWorkspace.files[0]?.id ?? "");
            }}
          >
            {workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
      </motion.header>

      <section className="workspace-meta">
        <div className="meta-card">
          <span className="meta-label">Current root</span>
          <strong>{workspace.root}</strong>
        </div>
        <div className="meta-card">
          <span className="meta-label">Shell status</span>
          <strong>Explorer, tabs, and editor live</strong>
        </div>
        <div className="meta-card">
          <span className="meta-label">Next surface</span>
          <strong>Server-backed file system and session persistence</strong>
        </div>
      </section>

      <section className="studio-layout">
        <motion.aside
          className="sidebar-panel"
          initial={{ opacity: 0, x: -18 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4, delay: 0.08, ease: "easeOut" }}
        >
          <div className="panel-heading">
            <div>
              <p className="panel-label">Explorer</p>
              <h2>Project files</h2>
            </div>
            <span className="chip">{workspace.files.length} files</span>
          </div>

          <div className="file-tree">
            {workspace.files.map((file, index) => {
              const isActive = file.id === activeFile.id;

              return (
                <motion.button
                  key={file.id}
                  className={`file-row${isActive ? " file-row-active" : ""}`}
                  onClick={() => openFile(file.id)}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.06 * index, duration: 0.22 }}
                >
                  <span className="file-language">{file.language.slice(0, 2)}</span>
                  <span>
                    <strong>{file.name}</strong>
                    <small>{file.path}</small>
                  </span>
                </motion.button>
              );
            })}
          </div>
        </motion.aside>

        <motion.section
          className="editor-panel"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.42, delay: 0.1, ease: "easeOut" }}
        >
          <div className="panel-heading editor-heading">
            <div>
              <p className="panel-label">Editor</p>
              <h2>Workspace shell</h2>
            </div>
            <button className="save-button" type="button">
              Save draft
            </button>
          </div>

          <div className="tab-strip">
            <AnimatePresence initial={false}>
              {openFiles.map((file) => {
                const isActive = file.id === activeFile.id;
                return (
                  <motion.button
                    key={file.id}
                    className={`tab-button${isActive ? " tab-button-active" : ""}`}
                    onClick={() => setActiveFileId(file.id)}
                    layout
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.18 }}
                  >
                    <span>{file.name}</span>
                    {openFiles.length > 1 ? (
                      <span
                        className="tab-close"
                        onClick={(event) => {
                          event.stopPropagation();
                          closeFile(file.id);
                        }}
                      >
                        x
                      </span>
                    ) : null}
                  </motion.button>
                );
              })}
            </AnimatePresence>
          </div>

          <div className="editor-instance">
            <Editor
              height="100%"
              theme="vs-dark"
              language={activeFile.language}
              value={drafts[activeFile.id] ?? activeFile.content}
              onChange={(value) => {
                setDrafts((current) => ({
                  ...current,
                  [activeFile.id]: value ?? ""
                }));
              }}
              options={{
                minimap: { enabled: false },
                fontSize: 14,
                fontLigatures: true,
                smoothScrolling: true,
                scrollBeyondLastLine: false,
                padding: { top: 16 },
                automaticLayout: true
              }}
            />
          </div>
        </motion.section>

        <motion.aside
          className="activity-panel"
          initial={{ opacity: 0, x: 18 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4, delay: 0.14, ease: "easeOut" }}
        >
          <div className="panel-heading">
            <div>
              <p className="panel-label">Build status</p>
              <h2>Phase progress</h2>
            </div>
            <span className="chip chip-live">live</span>
          </div>

          <div className="activity-list">
            {activityItems.map((item, index) => (
              <motion.article
                key={item}
                className="activity-item"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.07 * index, duration: 0.24 }}
              >
                <span className="activity-index">0{index + 1}</span>
                <p>{item}</p>
              </motion.article>
            ))}
          </div>

          <div className="inspector-card">
            <span className="meta-label">Active file</span>
            <strong>{activeFile.path}</strong>
            <p>
              This is currently using mocked workspace data so we can refine the
              shell before wiring the local runtime and real filesystem access.
            </p>
          </div>
        </motion.aside>
      </section>
    </main>
  );
}
