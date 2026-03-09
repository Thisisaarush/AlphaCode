import { z } from "zod";

export const APP_NAME = "Alpha Code";

export const providerIdSchema = z.enum([
  "github",
  "copilot-experimental",
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
  files: z.array(fileEntrySchema)
});

export const sessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["idle", "running", "review"]),
  provider: z.string(),
  model: z.string(),
  updatedAt: z.string()
});

export const promptSuggestionSchema = z.object({
  id: z.string(),
  label: z.string()
});

export const workspaceSnapshotSchema = z.object({
  workspace: workspaceSchema,
  sessions: z.array(sessionSummarySchema),
  suggestions: z.array(promptSuggestionSchema),
  providers: z.array(
    z.object({
      id: providerIdSchema,
      label: z.string(),
      status: providerStatusSchema,
      model: z.string()
    })
  )
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
export type PromptSuggestion = z.infer<typeof promptSuggestionSchema>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
