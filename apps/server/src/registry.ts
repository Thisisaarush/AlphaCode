export type ToolDefinition = {
  id: string;
  description: string;
  source: "core" | "plugin";
};

export type AgentDefinition = {
  id: string;
  label: string;
  description?: string;
  source: "core" | "plugin";
};

export type PluginDefinition = {
  id: string;
  label: string;
  version?: string;
};

export type AuthProviderDefinition = {
  id: string;
  label: string;
  methods: Array<"oauth" | "api_key">;
};

const tools: ToolDefinition[] = [];
const agents: AgentDefinition[] = [];
const plugins: PluginDefinition[] = [];
const authProviders: AuthProviderDefinition[] = [];

export function registerTool(def: ToolDefinition): void {
  tools.push(def);
}

export function registerAgent(def: AgentDefinition): void {
  agents.push(def);
}

export function registerPlugin(def: PluginDefinition): void {
  plugins.push(def);
}

export function registerAuthProvider(def: AuthProviderDefinition): void {
  authProviders.push(def);
}

export function getRegistrySnapshot() {
  return {
    tools: [...tools],
    agents: [...agents],
    plugins: [...plugins],
    authProviders: [...authProviders]
  };
}
