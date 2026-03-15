import {
  FolderGit2,
  GitBranch,
  Search,
  PanelLeft,
  Terminal,
  PanelRight,
  Minus,
  Maximize2,
  X,
} from "lucide-react";
import { APP_NAME } from "@alpha-code/shared";
import "./Titlebar.scss";

interface TitlebarProps {
  isElectron: boolean;
  isMac: boolean;
  workspaceName?: string;
  branch?: string;
  showLeftPanel: boolean;
  showTerminal: boolean;
  showRightPanel: boolean;
  onToggleLeftPanel: () => void;
  onToggleTerminal: () => void;
  onToggleRightPanel: () => void;
  onOpenSearch: () => void;
  onOpenProjectSwitcher: () => void;
  onOpenBranchSwitcher: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
  onClose?: () => void;
}

export function Titlebar({
  isElectron,
  isMac,
  workspaceName,
  branch,
  showLeftPanel,
  showTerminal,
  showRightPanel,
  onToggleLeftPanel,
  onToggleTerminal,
  onToggleRightPanel,
  onOpenSearch,
  onOpenProjectSwitcher,
  onOpenBranchSwitcher,
  onMinimize,
  onMaximize,
  onClose,
}: TitlebarProps) {
  return (
    <header
      className={`titlebar${isElectron ? " electron" : ""}${isMac ? " mac" : ""}`}
    >
      <div className="titlebar-side left">
        <span className="brand-lockup">{APP_NAME}</span>
        <button
          className="titlebar-chip muted"
          type="button"
          title="Open project folder"
          onClick={onOpenProjectSwitcher}
        >
          <FolderGit2 size={12} />
          <span>{workspaceName}</span>
        </button>
        <button
          className="titlebar-chip muted"
          type="button"
          title="Switch branch"
          onClick={onOpenBranchSwitcher}
        >
          <GitBranch size={12} />
          <span>{branch ?? "main"}</span>
        </button>
      </div>

      <div className="titlebar-center">
        <button
          className="command-palette"
          type="button"
          onClick={onOpenSearch}
        >
          <Search size={13} />
          <span>Search files, sessions, commands</span>
          <kbd>Cmd K</kbd>
        </button>
      </div>

      <div className="titlebar-side right">
        <button
          className={`toggle-panel-btn${showLeftPanel ? " active" : ""}`}
          type="button"
          onClick={onToggleLeftPanel}
          title="Toggle sidebar panel"
        >
          <PanelLeft size={12} />
        </button>
        <button
          className={`toggle-panel-btn${showTerminal ? " active" : ""}`}
          type="button"
          onClick={onToggleTerminal}
          title="Toggle terminal"
        >
          <Terminal size={12} />
        </button>
        <button
          className={`toggle-panel-btn${showRightPanel ? " active" : ""}`}
          type="button"
          onClick={onToggleRightPanel}
          title="Toggle editor panel"
        >
          <PanelRight size={12} />
        </button>

        {isElectron && !isMac && (
          <div className="window-controls">
            <button
              className="window-control-btn"
              type="button"
              onClick={onMinimize}
              title="Minimize"
            >
              <Minus size={14} />
            </button>
            <button
              className="window-control-btn"
              type="button"
              onClick={onMaximize}
              title="Maximize"
            >
              <Maximize2 size={12} />
            </button>
            <button
              className="window-control-btn close"
              type="button"
              onClick={onClose}
              title="Close"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
