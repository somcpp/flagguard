import type { Logger } from "../logger.js";
import {
  type ClientOptions,
  GeminiClient,
  type LlmClient,
  LlmError,
  OpenAiCompatibleClient,
} from "./client.js";
import { hasKeyhopperKeys, KeyhopperClient } from "./keyhopper.js";

/**
 * Build the configured client, or null when no key is set (rules-only mode).
 *
 * `auto` (default) prefers keyhopper when multi-key env vars such as
 * GROQ_API_KEYS / GEMINI_API_KEYS are present, else a single-key client.
 */
export function createLlmClient(
  config: {
    LLM_PROVIDER: "auto" | "keyhopper" | "gemini" | "openai-compatible";
    LLM_API_KEY?: string | undefined;
    LLM_MODEL?: string | undefined;
    LLM_BASE_URL?: string | undefined;
  },
  options: { env?: NodeJS.ProcessEnv; logger?: Logger } = {},
): LlmClient | null {
  const env = options.env ?? process.env;
  const wantsKeyhopper =
    config.LLM_PROVIDER === "keyhopper" ||
    (config.LLM_PROVIDER === "auto" && hasKeyhopperKeys(env)) ||
    // A pinned single-key provider with no key configured: use the multi-key setup instead.
    (!config.LLM_API_KEY && hasKeyhopperKeys(env));
  if (wantsKeyhopper) {
    if (!hasKeyhopperKeys(env)) {
      throw new LlmError("LLM_PROVIDER=keyhopper needs keys, e.g. GROQ_API_KEYS=gsk_a,gsk_b");
    }
    return new KeyhopperClient({ env, ...(options.logger ? { logger: options.logger } : {}) });
  }
  if (!config.LLM_API_KEY) return null;
  const clientOptions: ClientOptions = {
    apiKey: config.LLM_API_KEY,
    ...(config.LLM_MODEL ? { model: config.LLM_MODEL } : {}),
    ...(config.LLM_BASE_URL ? { baseUrl: config.LLM_BASE_URL } : {}),
  };
  return config.LLM_PROVIDER === "openai-compatible"
    ? new OpenAiCompatibleClient(clientOptions)
    : new GeminiClient(clientOptions);
}
