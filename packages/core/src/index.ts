export * from "./errors.js";
export * from "./logger.js";
export * from "./config/env.js";
export * from "./policy/schema.js";
export * from "./policy/load.js";
export * from "./autonomy/autonomy.js";
export * from "./flagsmith/types.js";
export * from "./flagsmith/http.js";
export * from "./flagsmith/client.js";
export * from "./flagsmith/flag-service.js";

import { type Env } from "./config/env.js";
import { FlagsmithClient } from "./flagsmith/client.js";
import { FlagService } from "./flagsmith/flag-service.js";
import { type FetchLike, HttpClient } from "./flagsmith/http.js";
import { type Logger, silentLogger } from "./logger.js";

/** Wire up the Flagsmith client stack from validated environment config. */
export function createFlagsmith(
  env: Pick<Env, "FLAGSMITH_API_KEY" | "FLAGSMITH_API_URL" | "FLAGSMITH_PROJECT_ID">,
  options: { logger?: Logger; fetch?: FetchLike } = {},
): { client: FlagsmithClient; flags: FlagService } {
  const logger = options.logger ?? silentLogger;
  const http = new HttpClient({
    baseUrl: env.FLAGSMITH_API_URL,
    apiKey: env.FLAGSMITH_API_KEY,
    logger,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const client = new FlagsmithClient(http);
  return { client, flags: new FlagService(client, env.FLAGSMITH_PROJECT_ID, logger) };
}
