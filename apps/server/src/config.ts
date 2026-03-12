import { homedir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { configSchema, type AppConfig } from "@alpha-code/shared";

type ConfigPaths = {
  globalPath: string;
  projectPath: string;
};

const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  permissions: {
    tools: {
      run_command: "ask",
      write_file: "ask",
      read_file: "allow",
      list_files: "allow"
    },
    plugins: "ask"
  },
  agents: {
    enabled: true,
    defaultAgent: "default"
  },
  skills: {
    enabled: true,
    paths: []
  },
  sharing: {
    mode: "manual",
    localOnly: true
  }
};

function getConfigPaths(workspaceRoot: string): ConfigPaths {
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
  const globalPath = process.env.ALPHA_CODE_CONFIG_GLOBAL
    ? path.resolve(process.env.ALPHA_CODE_CONFIG_GLOBAL)
    : path.join(xdg, "alpha-code", "alpha-code.jsonc");
  const projectPath = process.env.ALPHA_CODE_CONFIG_PROJECT
    ? path.resolve(process.env.ALPHA_CODE_CONFIG_PROJECT)
    : path.join(workspaceRoot, "alpha-code.jsonc");

  return { globalPath, projectPath };
}

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? "";
    const next = input[i + 1] ?? "";

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (!escape && char === "\"") {
        inString = false;
      }
      escape = !escape && char === "\\";
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function mergeConfigs(base: AppConfig, override: AppConfig): AppConfig {
  const result: AppConfig = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const baseValue = (result as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      (result as Record<string, unknown>)[key] = value;
    } else if (value && typeof value === "object" && baseValue && typeof baseValue === "object" && !Array.isArray(baseValue)) {
      (result as Record<string, unknown>)[key] = mergeConfigs(baseValue as AppConfig, value as AppConfig);
    } else {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

async function readConfigFile(filePath: string): Promise<AppConfig | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(stripJsonComments(raw));
    return configSchema.parse(parsed);
  } catch {
    return null;
  }
}

export async function loadConfig(workspaceRoot: string): Promise<{ config: AppConfig; paths: ConfigPaths }> {
  const paths = getConfigPaths(workspaceRoot);
  const globalConfig = await readConfigFile(paths.globalPath);
  const projectConfig = await readConfigFile(paths.projectPath);
  const merged = mergeConfigs(DEFAULT_CONFIG, mergeConfigs(globalConfig ?? {}, projectConfig ?? {}));
  return { config: merged, paths };
}
