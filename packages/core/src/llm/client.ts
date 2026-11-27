import { FlagGuardError } from "../errors.js";
import type { FetchLike } from "../flagsmith/http.js";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
  model: string;
}

export interface LlmRequest {
  system: string;
  prompt: string;
  /** Ask the provider for a JSON object response. */
  json?: boolean;
  temperature?: number;
}

/** Provider-agnostic text completion. FlagGuard never depends on one vendor. */
export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends FlagGuardError {
  constructor(message: string, options?: ErrorOptions) {
    super("LLM_ERROR", message, options);
  }
}

interface ClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Pull the human-readable message out of a provider error body. */
function errorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string };
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (message) return message;
  } catch {
    // not JSON
  }
  return text.slice(0, 200);
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  retries = 2,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new LlmError(`LLM request failed: ${(cause as Error).message}`, { cause });
    }
    const text = await response.text();
    if (response.ok) {
      try {
        return JSON.parse(text) as unknown;
      } catch (cause) {
        throw new LlmError("LLM API returned invalid JSON", { cause });
      }
    }
    // Overloaded or rate-limited providers usually recover within seconds.
    if (RETRYABLE.has(response.status) && attempt < retries) {
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    // Never echo request headers: they contain the API key.
    throw new LlmError(`LLM API returned ${response.status}: ${errorMessage(text)}`);
  }
}

/** Google Gemini via the Generative Language REST API. */
export class GeminiClient implements LlmClient {
  readonly provider = "gemini";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gemini-flash-latest";
    this.baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const data = (await postJson(
      this.fetchImpl,
      `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
      { "x-goog-api-key": this.apiKey },
      {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.prompt }] }],
        generationConfig: {
          temperature: request.temperature ?? 0.2,
          ...(request.json ? { responseMimeType: "application/json" } : {}),
        },
      },
      this.timeoutMs,
    )) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
      };
    };

    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (text === "") {
      throw new LlmError(
        `Gemini returned no content (finishReason: ${data.candidates?.[0]?.finishReason ?? "unknown"})`,
      );
    }
    return {
      text,
      model: this.model,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens:
          (data.usageMetadata?.candidatesTokenCount ?? 0) +
          (data.usageMetadata?.thoughtsTokenCount ?? 0),
      },
    };
  }
}

/** Any OpenAI-compatible chat completions API (OpenAI, Groq, OpenRouter, Ollama...). */
export class OpenAiCompatibleClient implements LlmClient {
  readonly provider = "openai-compatible";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    if (!options.model) throw new LlmError("LLM_MODEL is required for openai-compatible providers");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const data = (await postJson(
      this.fetchImpl,
      `${this.baseUrl}/chat/completions`,
      { Authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        temperature: request.temperature ?? 0.2,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.prompt },
        ],
        ...(request.json ? { response_format: { type: "json_object" } } : {}),
      },
      this.timeoutMs,
    )) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (text === "") throw new LlmError("LLM returned no content");
    return {
      text,
      model: this.model,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}

/** Build the configured client, or null when no key is set (rules-only mode). */
export function createLlmClient(config: {
  LLM_PROVIDER: "gemini" | "openai-compatible";
  LLM_API_KEY?: string | undefined;
  LLM_MODEL?: string | undefined;
  LLM_BASE_URL?: string | undefined;
}): LlmClient | null {
  if (!config.LLM_API_KEY) return null;
  const options: ClientOptions = {
    apiKey: config.LLM_API_KEY,
    ...(config.LLM_MODEL ? { model: config.LLM_MODEL } : {}),
    ...(config.LLM_BASE_URL ? { baseUrl: config.LLM_BASE_URL } : {}),
  };
  return config.LLM_PROVIDER === "gemini"
    ? new GeminiClient(options)
    : new OpenAiCompatibleClient(options);
}
