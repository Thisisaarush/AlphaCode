import type { AppConfig, PermissionLevel } from "@alpha-code/shared";

export type ToolAction = "run_command" | "read_file" | "list_files" | "write_file";

const DEFAULT_TOOL_PERMISSIONS: Record<ToolAction, PermissionLevel> = {
  run_command: "ask",
  write_file: "ask",
  read_file: "allow",
  list_files: "allow"
};

export function getToolPermission(config: AppConfig | null, action: ToolAction): PermissionLevel {
  const configured = config?.permissions?.tools?.[action];
  return configured ?? DEFAULT_TOOL_PERMISSIONS[action];
}

export function getPluginPermission(config: AppConfig | null): PermissionLevel {
  return config?.permissions?.plugins ?? "ask";
}
