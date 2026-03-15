import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import "./components/Titlebar/Titlebar.scss";
import "./components/Sidebar/Sidebar.scss";
import "./components/MessageTimeline/MessageTimeline.scss";
import "./components/Dock/Dock.scss";
import "./components/Terminal/Terminal.scss";
import "./components/Editor/Editor.scss";

const App = lazy(() => import("./App"));

function LoadingFallback() {
  return (
    <div className="loading-shell">
      <div className="loading-mark">
        <span className="logo-block" />
        <strong>Alpha Code</strong>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<LoadingFallback />}>
      <App />
    </Suspense>
  </React.StrictMode>,
);
