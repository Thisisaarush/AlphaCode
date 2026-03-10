import { z } from "zod";

export const APP_NAME = "Alpha Code";

const sessionStatusSchema = z.enum(["idle", "running", "review"]);
const commandRunStatusSchema = z.enum(["running", "completed", "failed", "killed"]);

/* ================================================================
   Tool Call Types
   ================================================================ */

export const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),           // JSON-encoded arguments string from the AI
  parsedArgs: z.record(z.string(), z.unknown()).optional()  // parsed version for convenience
});

export const toolResultSchema = z.object({
  toolCallId: z.string(),
  name: z.string(),
  result: z.string(),              // string output of the tool execution
  isError: z.boolean().optional()
});

export const providerIdSchema = z.enum([
  "copilot",
  "openrouter",
  "anthropic",
  "openai"
]);

export const providerStatusSchema = z.enum([
  "connected",
  "disconnected",
  "error",
  "experimental"
]);

export const authMethodSchema = z.enum(["env", "stored_key", "oauth", "none"]);

export const fileEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  language: z.string(),
  folder: z.string(),
  content: z.string()
});

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  root: z.string(),
  branch: z.string().optional(),
  files: z.array(fileEntrySchema)
});

export const sessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: sessionStatusSchema,
  provider: z.string(),
  model: z.string(),
  updatedAt: z.string()
});

export const sessionMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  createdAt: z.string(),
  // Present on assistant messages that invoke tools
  toolCalls: z.array(toolCallSchema).optional(),
  // Present on tool-result messages (role === "tool")
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  isError: z.boolean().optional()
});

export const commandRunSchema = z.object({
  id: z.string(),
  sessionId: z.string().optional(),
  command: z.string(),
  status: commandRunStatusSchema,
  output: z.string(),
  exitCode: z.number().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable()
});

export const sessionDetailSchema = sessionSummarySchema.extend({
  activeFilePath: z.string().optional(),
  messages: z.array(sessionMessageSchema),
  commandRuns: z.array(commandRunSchema)
});

export const promptSuggestionSchema = z.object({
  id: z.string(),
  label: z.string()
});

export const workspaceSnapshotSchema = z.object({
  workspace: workspaceSchema,
  sessions: z.array(sessionSummarySchema),
  suggestions: z.array(promptSuggestionSchema),
  recentRuns: z.array(commandRunSchema),
  providers: z.array(
    z.object({
      id: providerIdSchema,
      label: z.string(),
      status: providerStatusSchema,
      model: z.string(),
      models: z.array(z.string()).optional(),
      method: authMethodSchema.optional()
    })
  )
});

export const createSessionSchema = z.object({
  prompt: z.string().min(1),
  provider: z.string(),
  model: z.string(),
  filePath: z.string().optional()
});

export const appendMessageSchema = z.object({
  sessionId: z.string(),
  prompt: z.string().min(1),
  provider: z.string(),
  model: z.string(),
  filePath: z.string().optional()
});

export const createCommandRunSchema = z.object({
  command: z.string().min(1),
  sessionId: z.string().optional()
});

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  appName: z.string(),
  timestamp: z.string()
});

export type ProviderId = z.infer<typeof providerIdSchema>;
export type ProviderStatus = z.infer<typeof providerStatusSchema>;
export type FileEntry = z.infer<typeof fileEntrySchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionMessage = z.infer<typeof sessionMessageSchema>;
export type CommandRun = z.infer<typeof commandRunSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;
export type ToolResult = z.infer<typeof toolResultSchema>;
export type SessionDetail = z.infer<typeof sessionDetailSchema>;
export type PromptSuggestion = z.infer<typeof promptSuggestionSchema>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type AppendMessageInput = z.infer<typeof appendMessageSchema>;
export type CreateCommandRunInput = z.infer<typeof createCommandRunSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/* ================================================================
   Auth schemas
   ================================================================ */

export const providerAuthStatusSchema = z.object({
  id: providerIdSchema,
  label: z.string(),
  status: providerStatusSchema,
  method: authMethodSchema
});

export const authStatusResponseSchema = z.object({
  providers: z.array(providerAuthStatusSchema)
});

export const saveKeyInputSchema = z.object({
  provider: providerIdSchema,
  key: z.string().min(1)
});

export const githubDeviceCodeResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  expiresIn: z.number(),
  interval: z.number()
});

export const githubPollResponseSchema = z.object({
  status: z.enum(["pending", "completed", "expired", "error"]),
  token: z.string().optional(),
  error: z.string().optional(),
  interval: z.number().optional()
});

export type AuthMethod = z.infer<typeof authMethodSchema>;
export type ProviderAuthStatus = z.infer<typeof providerAuthStatusSchema>;
export type AuthStatusResponse = z.infer<typeof authStatusResponseSchema>;
export type SaveKeyInput = z.infer<typeof saveKeyInputSchema>;
export type GitHubDeviceCodeResponse = z.infer<typeof githubDeviceCodeResponseSchema>;
export type GitHubPollResponse = z.infer<typeof githubPollResponseSchema>;
