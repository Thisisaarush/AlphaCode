import { useMemo } from "react";
import Editor from "@monaco-editor/react";
import {
  Search,
  FileCode2,
  ChevronDown,
  ChevronRight,
  X,
  LoaderCircle,
} from "lucide-react";
import type { WorkspaceSnapshot } from "@alpha-code/shared";
import "./Editor.scss";

interface FileItem {
  id: string;
  path: string;
  name: string;
  content: string;
  language: string;
}

interface EditorPanelProps {
  show: boolean;
  activeFile: FileItem | null;
  openFiles: FileItem[];
  activeFileId: string;
  drafts: Record<string, string>;
  changedFiles: FileItem[];
  expandedGroups: Record<string, boolean>;
  onFileSelect: (fileId: string) => void;
  onFileClose: (fileId: string) => void;
  onContentChange: (fileId: string, content: string) => void;
  onToggleGroup: (path: string) => void;
  onTreeFilterChange: (filter: string) => void;
  treeFilter: string;
  onRefresh: () => void;
  onSave: () => void;
  saving: boolean;
}

type TreeNode = {
  name: string;
  path: string;
  type: "folder" | "file";
  children?: TreeNode[];
  file?: FileItem;
};

function buildTree(items: FileItem[]): TreeNode {
  const root: TreeNode = { name: "", path: "", type: "folder", children: [] };
  for (const file of items) {
    const parts = file.path.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFile = i === parts.length - 1;
      if (!current.children) current.children = [];
      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: currentPath,
          type: isFile ? "file" : "folder",
        };
        current.children.push(child);
      }
      if (isFile) child.file = file;
      else if (!child.children) child.children = [];
      current = child;
    }
  }
  const sortNode = (node: TreeNode) => {
    if (!node.children) return;
    node.children.sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "folder"
          ? -1
          : 1,
    );
    node.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

function filterTree(node: TreeNode, query: string): TreeNode | null {
  if (!query) return node;
  const q = query.toLowerCase();
  if (node.type === "file")
    return node.path.toLowerCase().includes(q) ? node : null;
  const children = (node.children ?? [])
    .map((child) => filterTree(child, query))
    .filter((child): child is TreeNode => Boolean(child));
  if (children.length > 0 || node.path.toLowerCase().includes(q))
    return { ...node, children };
  return null;
}

function TreeItem({
  node,
  depth,
  activeFileId,
  expandedGroups,
  onToggleGroup,
  onFileSelect,
  changedFiles,
}: {
  node: TreeNode;
  depth: number;
  activeFileId: string;
  expandedGroups: Record<string, boolean>;
  onToggleGroup: (path: string) => void;
  onFileSelect: (id: string) => void;
  changedFiles: FileItem[];
}) {
  const key = node.path;
  if (node.type === "folder") {
    const expanded = expandedGroups[key] ?? true;
    return (
      <div key={key} className="tree-group">
        <button
          className="tree-header"
          type="button"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => onToggleGroup(key)}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{node.name}</span>
        </button>
        {expanded && node.children && (
          <div className="tree-items">
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                activeFileId={activeFileId}
                expandedGroups={expandedGroups}
                onToggleGroup={onToggleGroup}
                onFileSelect={onFileSelect}
                changedFiles={changedFiles}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
  const file = node.file!;
  const dirty = changedFiles.some((f) => f.id === file.id);
  return (
    <button
      className={`tree-item${activeFileId === file.id ? " active" : ""}`}
      type="button"
      style={{ paddingLeft: 20 + depth * 12 }}
      onClick={() => onFileSelect(file.id)}
    >
      <FileCode2 size={12} />
      <span>{file.name}</span>
      {dirty && <span className="dirty-dot" />}
    </button>
  );
}

export function EditorPanel({
  show,
  activeFile,
  openFiles,
  activeFileId,
  drafts,
  changedFiles,
  expandedGroups,
  onFileSelect,
  onFileClose,
  onContentChange,
  onToggleGroup,
  onTreeFilterChange,
  treeFilter,
  onRefresh,
  onSave,
  saving,
}: EditorPanelProps) {
  if (!show) return null;

  const files: FileItem[] = []; // Would come from props
  const fileTree = useMemo(() => buildTree(files), [files]);
  const filteredTree = useMemo(
    () => filterTree(fileTree, treeFilter.trim()),
    [fileTree, treeFilter],
  );

  return (
    <section className="right-panel">
      <div className="pane-header">
        <div>
          <span className="pane-kicker">Editor</span>
          <h2>{activeFile?.path ?? "No file"}</h2>
        </div>
      </div>
      {activeFile && (
        <div className="context-summary-row">
          <span>{activeFile.language}</span>
          <span>{changedFiles.length} changed</span>
        </div>
      )}
      {openFiles.length > 0 && (
        <div className="tab-strip compact-scroll">
          {openFiles.map((file) => (
            <div
              key={file.id}
              className={`tab-chip${activeFile?.id === file.id ? " active" : ""}`}
            >
              <button
                className="tab-chip-main"
                type="button"
                onClick={() => onFileSelect(file.id)}
              >
                <span>{file.name}</span>
              </button>
              <button
                className="tab-chip-close"
                type="button"
                aria-label={`Close ${file.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onFileClose(file.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="editor-layout">
        <div className="editor-pane">
          {activeFile ? (
            <Editor
              height="100%"
              language={activeFile.language}
              theme="vs-dark"
              value={drafts[activeFile.id] ?? activeFile.content}
              onChange={(value) => onContentChange(activeFile.id, value ?? "")}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineHeight: 20,
                automaticLayout: true,
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                padding: { top: 10 },
                wordWrap: "off",
              }}
            />
          ) : (
            <div className="empty-editor">Open a file to edit.</div>
          )}
        </div>
        <div className="editor-sidebar">
          <div className="tree-search">
            <Search size={12} />
            <input
              type="text"
              placeholder="Filter files..."
              value={treeFilter}
              onChange={(e) => onTreeFilterChange(e.target.value)}
            />
          </div>
          <div className="tree-root compact-scroll">
            {(filteredTree?.children ?? []).map((node) => (
              <TreeItem
                key={node.path}
                node={node}
                depth={0}
                activeFileId={activeFileId}
                expandedGroups={expandedGroups}
                onToggleGroup={onToggleGroup}
                onFileSelect={onFileSelect}
                changedFiles={changedFiles}
              />
            ))}
          </div>
        </div>
      </div>
      {activeFile && (
        <div className="context-footer">
          <button className="pane-button" type="button" onClick={onRefresh}>
            <Search size={12} />
            <span>Refresh</span>
          </button>
          <button
            className="titlebar-action primary"
            type="button"
            onClick={onSave}
          >
            {saving ? (
              <LoaderCircle className="spin" size={13} />
            ) : (
              <FileCode2 size={13} />
            )}
            <span>{saving ? "Saving" : "Save"}</span>
          </button>
        </div>
      )}
    </section>
  );
}
