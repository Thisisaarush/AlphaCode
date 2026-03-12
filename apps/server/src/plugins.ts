import path from "node:path";
import { pathToFileURL } from "node:url";
import { readdir } from "node:fs/promises";
import type { AppConfig } from "@alpha-code/shared";
import { registerTool, registerPlugin } from "./registry.js";
import { getPluginPermission } from "./permissions.js";

export type PluginTool = {
  id: string;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<string>;
};

export type PluginDefinition = {
  id: string;
  label: string;
  version?: string;
  tools?: PluginTool[];
};

export type LoadedPlugin = {
  definition: PluginDefinition;
  source: string;
};

export type PluginRuntime = {
  tools: Map<string, PluginTool>;
  plugins: LoadedPlugin[];
};

const DEFAULT_PLUGIN_DIRS = [
  ".alpha-code/plugins"
];

async function loadPluginFromFile(filePath: string): Promise<PluginDefinition | null> {
  try {
    const mod = await import(pathToFileURL(path.resolve(filePath)).toString());
    const plugin = (mod?.default ?? mod?.plugin ?? mod) as PluginDefinition;
    if (!plugin || !plugin.id) return null;
    return plugin;
  } catch {
    return null;
  }
}

export async function loadPlugins(
  workspaceRoot: string,
  config: AppConfig | null
): Promise<PluginRuntime> {
  const tools = new Map<string, PluginTool>();
  const plugins: LoadedPlugin[] = [];

  if (config?.plugins?.enabled === false) {
    return { tools, plugins };
  }

  const permission = getPluginPermission(config);
  if (permission === "deny") {
    return { tools, plugins };
  }

  const allowList = new Set(config?.plugins?.allowList ?? []);
  const denyList = new Set(config?.plugins?.denyList ?? []);

  const configuredDirs = config?.plugins?.directories ?? [];
  const allDirs = [...DEFAULT_PLUGIN_DIRS, ...configuredDirs];

  for (const dir of allDirs) {
    const abs = path.resolve(workspaceRoot, dir);
    let entries: string[] = [];
    try {
      entries = (await readdir(abs)).map((e) => path.join(abs, e));
    } catch {
      continue;
    }

    for (const file of entries) {
      if (denyList.has(file) || denyList.has(path.basename(file))) continue;
      if (allowList.size > 0 && !allowList.has(file) && !allowList.has(path.basename(file))) continue;
      if (!file.endsWith(".js") && !file.endsWith(".mjs") && !file.endsWith(".cjs")) continue;

      const plugin = await loadPluginFromFile(file);
      if (!plugin) continue;
      const loaded: LoadedPlugin = { definition: plugin, source: file };
      plugins.push(loaded);
      registerPlugin({ id: plugin.id, label: plugin.label, version: plugin.version });
      if (plugin.tools) {
        for (const tool of plugin.tools) {
          tools.set(tool.id, tool);
          registerTool({ id: tool.id, description: tool.description, source: "plugin" });
        }
      }
    }
  }

  return { tools, plugins };
}
