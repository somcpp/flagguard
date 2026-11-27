import { createGateway, type Gateway, GatewayError, providersFromEnv } from "keyhopper";
import { type Logger, silentLogger } from "../logger.js";
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from "./client.js";

/** Env vars keyhopper reads keys from (comma-separated lists). */
export const KEYHOPPER_KEY_VARS = [
  "GROQ_API_KEYS",
  "GEMINI_API_KEYS",
  "CEREBRAS_API_KEYS",
  "OPENROUTER_API_KEYS",
  "NVIDIA_API_KEYS",
  "MISTRAL_API_KEYS",
  "TOGETHER_API_KEYS",
  "DEEPSEEK_API_KEYS",
  "OPENAI_API_KEYS",
] as const;

export function hasKeyhopperKeys(env: NodeJS.ProcessEnv = process.env): boolean {
  return KEYHOPPER_KEY_VARS.some((name) => (env[name] ?? "").trim() !== "");
}

/**
 * Multi-key, multi-provider LLM access via keyhopper: when a key is rate
 * limited or a provider is overloaded, it moves to the next key, model or
 * provider (e.g. Groq → Gemini) instead of failing the review.
 */
export class KeyhopperClient implements LlmClient {
  readonly provider = "keyhopper";
  private readonly gateway: Gateway;
  private readonly timeoutMs: number;
  private lastModel: string;

  constructor(
    options: {
      env?: NodeJS.ProcessEnv;
      gateway?: Gateway;
      logger?: Logger;
      timeoutMs?: number;
    } = {},
  ) {
    const logger = options.logger ?? silentLogger;
    // Fail over quickly: a PR bot should not wait minutes on one stuck model.
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.gateway =
      options.gateway ??
      createGateway({
        providers: providersFromEnv(options.env ?? process.env),
        loadEnv: false, // FlagGuard loads .env itself
        // Keep stdout clean for --json output: route keyhopper's lines through our logger (stderr).
        warnings: false,
        logs: (line) => {
          logger.debug(line);
        },
        timeoutMs: this.timeoutMs,
      });
    const first = this.gateway.providers[0];
    this.lastModel = first ? `${first.name}/${first.models[0] ?? "default"}` : "none";
  }

  /** "provider/model" that answered the most recent request. */
  get model(): string {
    return this.lastModel;
  }

  /** Configured providers with masked key counts, for diagnostics. */
  describe(): { provider: string; keys: number; models: string[] }[] {
    return this.gateway.providers.map((p) => ({
      provider: p.name,
      keys: p.keys.length,
      models: p.models,
    }));
  }

  check(): ReturnType<Gateway["check"]> {
    return this.gateway.check({ timeoutMs: 20_000 });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    let response;
    try {
      response = await this.gateway.chat(
        {
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.prompt },
          ],
          temperature: request.temperature ?? 0.2,
          ...(request.json ? { response_format: { type: "json_object" } } : {}),
        },
        { timeoutMs: this.timeoutMs },
      );
    } catch (error) {
      if (error instanceof GatewayError) {
        const tried = error.attempts
          .map((a) => `${a.provider}/${a.model} ${String(a.status ?? a.kind)}`)
          .join(", ");
        throw new LlmError(`All LLM providers failed (${tried || error.message})`, {
          cause: error,
        });
      }
      throw new LlmError(`LLM request failed: ${(error as Error).message}`, { cause: error });
    }

    const text = response.choices[0]?.message.content ?? "";
    if (text === "") throw new LlmError("LLM returned no content");
    this.lastModel = `${response._gateway.provider}/${response._gateway.model}`;
    const last = this.gateway.history(1).at(-1);

    return {
      text,
      model: this.lastModel,
      failovers: last?.failovers ?? 0,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}
