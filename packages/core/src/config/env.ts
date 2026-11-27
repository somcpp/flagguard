import { z } from "zod";
import { ConfigError } from "../errors.js";

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().trim().optional());

export const EnvSchema = z.object({
  FLAGSMITH_API_KEY: z.preprocess(
    emptyToUndefined,
    z.string({ error: "FLAGSMITH_API_KEY is required (Organisation API key)" }).trim(),
  ),
  FLAGSMITH_PROJECT_ID: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ error: "FLAGSMITH_PROJECT_ID must be the numeric project ID" })
      .int()
      .positive(),
  ),
  FLAGSMITH_API_URL: z.preprocess(emptyToUndefined, z.url().default("https://api.flagsmith.com")),
  LLM_PROVIDER: z.preprocess(
    emptyToUndefined,
    z.enum(["auto", "keyhopper", "gemini", "openai-compatible"]).default("auto"),
  ),
  LLM_API_KEY: optionalString,
  LLM_MODEL: optionalString,
  LLM_BASE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(["debug", "info", "warn", "error"]).default("info"),
  ),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Validate environment variables once at startup so misconfiguration fails fast
 * with a readable message instead of surfacing as a 401 deep inside a rollout.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
