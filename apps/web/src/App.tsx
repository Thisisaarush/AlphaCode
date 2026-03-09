import { APP_NAME } from "@alpha-code/shared";

const phaseCards = [
  "Workspace and Monaco editor shell",
  "Local runtime and SQLite persistence",
  "Provider connections and model selection",
  "GitHub-first integration and Copilot path"
];

export default function App() {
  return (
    <main className="app-shell">
      <section className="hero-panel">
        <p className="eyebrow">Phase 1</p>
        <h1>{APP_NAME}</h1>
        <p className="hero-copy">
          Local-first AI code editor scaffolding is live. Next we build the
          workspace shell, runtime backbone, and GitHub-first provider layer.
        </p>
      </section>

      <section className="roadmap-grid">
        {phaseCards.map((card, index) => (
          <article className="roadmap-card" key={card}>
            <span className="card-index">0{index + 1}</span>
            <p>{card}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
