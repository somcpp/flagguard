#!/usr/bin/env node
/* eslint-disable no-console -- this is the process entry point */
import { readFile } from "node:fs/promises";
import { loadDotEnv, SlidingWindowMetrics } from "@flagguard/core";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadShopConfig } from "./config.js";
import { type FlagProvider, FlagsmithFlagProvider, OfflineFlagProvider } from "./flags.js";

loadDotEnv();
const config = loadShopConfig();

const provider: FlagProvider = config.FLAGSMITH_SERVER_KEY
  ? new FlagsmithFlagProvider({
      serverKey: config.FLAGSMITH_SERVER_KEY,
      refreshSeconds: config.FLAG_REFRESH_SECONDS,
      ...(config.FLAGSMITH_SDK_API_URL ? { apiUrl: config.FLAGSMITH_SDK_API_URL } : {}),
    })
  : new OfflineFlagProvider(config.OFFLINE_ROLLOUT_PERCENT);

const app = createApp({
  flagName: config.SHOP_FLAG_NAME,
  provider,
  metrics: new SlidingWindowMetrics({ windowMs: config.METRICS_WINDOW_SECONDS * 1000 }),
  adminToken: config.SHOP_ADMIN_TOKEN,
  indexHtml: await readFile(new URL("../public/index.html", import.meta.url), "utf8"),
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`🛒 FlagGuard demo shop on http://localhost:${info.port}`);
  console.log(`   flag: ${config.SHOP_FLAG_NAME} · provider: ${provider.mode}`);
  if (provider.mode === "offline") {
    console.log("   (offline mode: set FLAGSMITH_SERVER_KEY to evaluate flags with Flagsmith)");
  }
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down`);
  server.close();
  await provider.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
