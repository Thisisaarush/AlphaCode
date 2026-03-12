import type { AppConfig } from "@alpha-code/shared";

export type AgentDefinition = {
  id: string;
  label: string;
  description?: string;
  systemPrompt?: string;
};

const DEFAULT_AGENTS: AgentDefinition[] = [
  {
    id: "default",
    label: "Default",
    description: "General-purpose coding assistant."
  },
  {
    id: "planner",
    label: "Planner",
    description: "Plan-oriented agent. Focuses on steps, risks, and strategy.",
    systemPrompt: "You are a planning-focused coding assistant. Respond with a clear, ordered plan before implementation details."
  },
  {
    id: "reviewer",
    label: "Reviewer",
    description: "Code reviewer. Focuses on risks, regressions, and edge cases.",
    systemPrompt: "You are a strict code reviewer. Prioritize correctness, security, and regression risk. Cite files/locations when possible."
  }
];

export function resolveAgents(config: AppConfig | null): AgentDefinition[] {
  if (config?.agents?.enabled === false) return [];
  const custom = config?.agents?.list ?? [];
  if (custom.length > 0) {
    return custom.map((agent) => ({
      id: agent.id,
      label: agent.label,
      description: agent.description,
      systemPrompt: agent.systemPrompt
    }));
  }
  return DEFAULT_AGENTS;
}

export function getDefaultAgent(config: AppConfig | null): string {
  return config?.agents?.defaultAgent ?? "default";
}

export function getAgentById(config: AppConfig | null, id: string): AgentDefinition | null {
  const agents = resolveAgents(config);
  return agents.find((agent) => agent.id === id) ?? null;
}
