import { FlagsmithApiError } from "../errors.js";
import { type Logger, silentLogger } from "../logger.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** API origin, e.g. https://api.flagsmith.com (no trailing path). */
  baseUrl: string;
  /** Organisation API key; sent as `Authorization: Api-Key <key>`. */
  apiKey: string;
  fetch?: FetchLike;
  logger?: Logger;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Retries for 429 / 5xx / network errors (in addition to the first attempt). */
  maxRetries?: number;
  /** Base delay for exponential backoff. */
  retryBaseDelayMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

const USER_AGENT = "flagguard (+https://github.com/somcpp/flagguard)";

/**
 * Thin JSON-over-HTTP client for the Flagsmith Admin API with timeouts,
 * retry with exponential backoff (honouring `Retry-After`) and typed errors.
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.logger = options.logger ?? silentLogger;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 300;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Build an absolute URL for an API path such as `/api/v1/projects/`. */
  url(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(path.startsWith("http") ? path : `${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.url(path, options.query);
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Api-Key ${this.apiKey}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    };

    for (let attempt = 0; ; attempt++) {
      let error: FlagsmithApiError;
      let retryAfterMs: number | undefined;

      try {
        const response = await this.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok) {
          this.logger.debug("flagsmith request ok", { method, path, status: response.status });
          return (await parseBody(response)) as T;
        }
        const body = await parseBody(response).catch(() => undefined);
        error = new FlagsmithApiError({
          method,
          path,
          status: response.status,
          body,
          message: `Flagsmith API ${method} ${path} failed with ${response.status}: ${summarize(body)}`,
        });
        retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      } catch (cause) {
        if (cause instanceof FlagsmithApiError) throw cause;
        error = new FlagsmithApiError({
          method,
          path,
          message: `Flagsmith API ${method} ${path} failed: ${(cause as Error).message}`,
          cause,
        });
      }

      // Only retry idempotent requests, plus rate-limited POSTs (rejected before processing).
      const idempotent = method !== "POST" || error.status === 429;
      if (!error.retryable || !idempotent || attempt >= this.maxRetries) throw error;

      const delay = retryAfterMs ?? this.retryBaseDelayMs * 2 ** attempt;
      this.logger.warn("flagsmith request failed, retrying", {
        method,
        path,
        status: error.status,
        attempt: attempt + 1,
        delayMs: delay,
      });
      await this.sleep(delay);
    }
  }

  get<T>(path: string, query?: RequestOptions["query"]): Promise<T> {
    return this.request<T>("GET", path, query ? { query } : {});
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body });
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }
  delete<T = void>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function summarize(body: unknown): string {
  if (body === undefined) return "<empty body>";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
