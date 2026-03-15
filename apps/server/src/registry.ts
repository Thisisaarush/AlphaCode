export type ToolDefinition = {
  id: string;
  description: string;
  source: "core" | "plugin";
};

export type PluginDefinition = {
  id: string;
  label: string;
  version?: string;
};

const tools: ToolDefinition[] = [];
const plugins: PluginDefinition[] = [];

export function registerTool(def: ToolDefinition): void {
  tools.push(def);
}

export function registerPlugin(def: PluginDefinition): void {
  plugins.push(def);
}

export function getRegistrySnapshot() {
  return {
    tools: [...tools],
    plugins: [...plugins]
  };
}
