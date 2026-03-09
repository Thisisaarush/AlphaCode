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

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  appName: z.string(),
  timestamp: z.string()
});

export type ProviderId = z.infer<typeof providerIdSchema>;
export type ProviderStatus = z.infer<typeof providerStatusSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
