import { z } from "zod";

const blank = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export const ShopConfigSchema = z.object({
  PORT: z.preprocess(blank, z.coerce.number().int().min(1).max(65_535).default(3000)),
  /** Flag guarding the new checkout. */
  SHOP_FLAG_NAME: z.preprocess(blank, z.string().min(1).default("fg_new_checkout")),
  /**
   * Server-side environment key (`ser.…`). When absent the shop runs in offline
   * mode with a local percentage rollout you can change via the admin API.
   */
  FLAGSMITH_SERVER_KEY: z.preprocess(blank, z.string().optional()),
  /** SDK API URL; only needed when self-hosting Flagsmith. */
  FLAGSMITH_SDK_API_URL: z.preprocess(blank, z.url().optional()),
  /** How often the SDK refreshes the environment document (local evaluation). */
  FLAG_REFRESH_SECONDS: z.preprocess(blank, z.coerce.number().int().min(1).default(5)),
  /** Initial rollout percentage in offline mode. */
  OFFLINE_ROLLOUT_PERCENT: z.preprocess(blank, z.coerce.number().int().min(0).max(100).default(0)),
  /** When set, /admin endpoints require `Authorization: Bearer <token>`. */
  SHOP_ADMIN_TOKEN: z.preprocess(blank, z.string().optional()),
  /** Sliding window for cohort metrics. */
  METRICS_WINDOW_SECONDS: z.preprocess(blank, z.coerce.number().int().min(10).default(120)),
});

export type ShopConfig = z.infer<typeof ShopConfigSchema>;

export function loadShopConfig(source: NodeJS.ProcessEnv = process.env): ShopConfig {
  const result = ShopConfigSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid shop configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
