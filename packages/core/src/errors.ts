/**
 * Base class for every error FlagGuard raises on purpose.
 * Callers can rely on `code` for programmatic handling instead of parsing messages.
 */
export class FlagGuardError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Invalid or missing configuration (env vars, flagguard.yml). */
export class ConfigError extends FlagGuardError {
  constructor(message: string, options?: ErrorOptions) {
    super("CONFIG_INVALID", message, options);
  }
}

/** A non-2xx response (or network failure) from the Flagsmith Admin API. */
export class FlagsmithApiError extends FlagGuardError {
  readonly status: number | undefined;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;

  constructor(params: {
    method: string;
    path: string;
    status?: number;
    body?: unknown;
    message: string;
    cause?: unknown;
  }) {
    super("FLAGSMITH_API_ERROR", params.message, { cause: params.cause });
    this.status = params.status;
    this.method = params.method;
    this.path = params.path;
    this.body = params.body;
  }

  /** True for errors worth retrying: rate limiting, server errors and network failures. */
  get retryable(): boolean {
    return this.status === undefined || this.status === 429 || this.status >= 500;
  }
}

/** The requested Flagsmith resource (project, environment, feature...) does not exist. */
export class NotFoundError extends FlagGuardError {
  constructor(message: string) {
    super("NOT_FOUND", message);
  }
}
