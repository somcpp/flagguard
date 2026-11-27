import { type FlagMetricsSnapshot, type SlidingWindowMetrics } from "@flagguard/core";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  type Chaos,
  type CheckoutDeps,
  CheckoutError,
  expressCheckout,
  legacyCheckout,
  newCheckout,
  NO_CHAOS,
  PRODUCTS,
} from "./checkout.js";
import { type FlagProvider, OfflineFlagProvider } from "./flags.js";

export interface AppDeps {
  flagName: string;
  provider: FlagProvider;
  metrics: SlidingWindowMetrics;
  adminToken?: string | undefined;
  /** Served at `/`. */
  indexHtml?: string;
  checkoutDeps?: CheckoutDeps;
  now?: () => number;
}

const CheckoutRequest = z.object({
  userId: z.string().trim().min(1).max(200),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().int().min(1).max(20),
      }),
    )
    .min(1)
    .max(20),
});

const ChaosRequest = z.object({
  errorRate: z.number().min(0).max(1).default(0),
  extraLatencyMs: z.number().int().min(0).max(10_000).default(0),
});

const RolloutRequest = z.object({ percentage: z.number().int().min(0).max(100) });

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => performance.now());
  let chaos: Chaos = { ...NO_CHAOS };

  const requireAdmin: MiddlewareHandler = async (c, next) => {
    if (deps.adminToken && c.req.header("authorization") !== `Bearer ${deps.adminToken}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };

  app.onError((error, c) => {
    console.error("unhandled error", error); // eslint-disable-line no-console
    return c.json({ error: "internal error" }, 500);
  });

  /* ------------------------------- storefront ------------------------------- */

  app.get("/", (c) => (deps.indexHtml ? c.html(deps.indexHtml) : c.text("FlagGuard demo shop")));
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/api/products", (c) => c.json(PRODUCTS));

  app.post("/api/checkout", async (c) => {
    const parsed = CheckoutRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const { userId, items } = parsed.data;

    const useNewCheckout = await deps.provider.isEnabled(deps.flagName, userId);
    const cohort = useNewCheckout ? "treatment" : "control";
    const started = now();

    try {
      const order = useNewCheckout
        ? await newCheckout(items, chaos, deps.checkoutDeps)
        : await legacyCheckout(items, deps.checkoutDeps);
      deps.metrics.record(deps.flagName, { cohort, ok: true, latencyMs: now() - started });
      return c.json(order);
    } catch (error) {
      if (error instanceof CheckoutError) {
        // Client errors are the caller's fault, not a health signal for the new code.
        if (error.status === 500) {
          deps.metrics.record(deps.flagName, { cohort, ok: false, latencyMs: now() - started });
        }
        return c.json(
          { error: error.message, checkout: useNewCheckout ? "new" : "legacy" },
          error.status,
        );
      }
      throw error;
    }
  });

  const ExpressRequest = CheckoutRequest.extend({
    customerId: z.string().min(1),
    paymentMethodId: z.string().min(1),
  });

  app.post("/api/checkout/express", async (c) => {
    const parsed = ExpressRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const { items, customerId, paymentMethodId } = parsed.data;
    try {
      return c.json(await expressCheckout(items, { customerId, paymentMethodId }));
    } catch (error) {
      if (error instanceof CheckoutError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  /* ------------------------- FlagGuard metrics contract ------------------------- */

  app.get("/flagguard/metrics/:flag", (c) => {
    const snapshot: FlagMetricsSnapshot = deps.metrics.snapshot(c.req.param("flag"));
    return c.json(snapshot);
  });

  app.get("/api/status", (c) =>
    c.json({
      flag: deps.flagName,
      provider: deps.provider.mode,
      offlinePercentage:
        deps.provider instanceof OfflineFlagProvider
          ? deps.provider.getPercentage(deps.flagName)
          : null,
      chaos,
    }),
  );

  /* ---------------------------------- admin ---------------------------------- */

  app.use("/admin/*", requireAdmin);

  app.put("/admin/chaos", async (c) => {
    const parsed = ChaosRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
    chaos = parsed.data;
    return c.json(chaos);
  });

  app.delete("/admin/chaos", (c) => {
    chaos = { ...NO_CHAOS };
    return c.json(chaos);
  });

  app.delete("/admin/metrics", (c) => {
    deps.metrics.reset(deps.flagName);
    return c.body(null, 204);
  });

  app.put("/admin/offline-rollout", async (c) => {
    if (!(deps.provider instanceof OfflineFlagProvider)) {
      return c.json({ error: "Rollout is managed by Flagsmith; offline control is disabled" }, 409);
    }
    const parsed = RolloutRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
    deps.provider.setPercentage(deps.flagName, parsed.data.percentage);
    return c.json({ flag: deps.flagName, percentage: parsed.data.percentage });
  });

  return app;
}
