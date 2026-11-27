#!/usr/bin/env node
/* eslint-disable no-console -- CLI output */
import { parseArgs } from "node:util";
import { PRODUCTS } from "./checkout.js";

/**
 * Traffic simulator: a steady stream of checkouts from a fixed pool of users,
 * so Flagsmith's percentage split has stable identities to bucket and
 * FlagGuard has metrics to watch.
 *
 *   flagguard-traffic --target http://localhost:3000 --rps 20 --users 500
 */

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "http://localhost:3000" },
    rps: { type: "string", default: "15" },
    users: { type: "string", default: "500" },
    duration: { type: "string", default: "0" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`Usage: flagguard-traffic [options]

  --target <url>      Shop base URL            (default http://localhost:3000)
  --rps <n>           Requests per second      (default 15)
  --users <n>         Distinct user identities (default 500)
  --duration <secs>   Stop after N seconds, 0 = run until Ctrl+C (default 0)`);
  process.exit(0);
}

function positiveInt(name: string, raw: string, allowZero = false): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    console.error(`--${name} must be a ${allowZero ? "non-negative" : "positive"} integer`);
    process.exit(2);
  }
  return value;
}

const target = values.target.replace(/\/+$/, "");
const rps = positiveInt("rps", values.rps);
const users = positiveInt("users", values.users);
const durationSec = positiveInt("duration", values.duration, true);

interface Tally {
  ok: number;
  failed: number;
}
const window: Record<"new" | "legacy", Tally> = {
  new: { ok: 0, failed: 0 },
  legacy: { ok: 0, failed: 0 },
};
let networkErrors = 0;
let inFlight = 0;

function randomCart(): { productId: string; quantity: number }[] {
  const count = 1 + Math.floor(Math.random() * 3);
  return Array.from({ length: count }, () => {
    const product = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)] ?? PRODUCTS[0];
    return { productId: product?.id ?? "rubber-duck", quantity: 1 + Math.floor(Math.random() * 2) };
  });
}

async function fireOne(): Promise<void> {
  inFlight++;
  const userId = `user-${1 + Math.floor(Math.random() * users)}`;
  try {
    const response = await fetch(`${target}/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, items: randomCart() }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as { checkout?: "new" | "legacy" };
    const bucket = body.checkout === "new" ? window.new : window.legacy;
    if (response.ok) bucket.ok++;
    else bucket.failed++;
  } catch {
    networkErrors++;
  } finally {
    inFlight--;
  }
}

function rate(t: Tally): string {
  const total = t.ok + t.failed;
  return total === 0 ? "   -  " : `${((t.failed / total) * 100).toFixed(1).padStart(5)}%`;
}

function report(): void {
  const n = window.new;
  const l = window.legacy;
  const newShare = n.ok + n.failed + l.ok + l.failed;
  const share = newShare === 0 ? 0 : ((n.ok + n.failed) / newShare) * 100;
  console.log(
    `${new Date().toLocaleTimeString()}  new checkout: ${String(n.ok + n.failed).padStart(4)} req, ${rate(n)} errors` +
      `  │  legacy: ${String(l.ok + l.failed).padStart(4)} req, ${rate(l)} errors` +
      `  │  on new: ${share.toFixed(0).padStart(3)}%` +
      (networkErrors > 0 ? `  │  ⚠ ${networkErrors} unreachable` : ""),
  );
  window.new = { ok: 0, failed: 0 };
  window.legacy = { ok: 0, failed: 0 };
  networkErrors = 0;
}

console.log(`🚦 Sending ~${rps} checkouts/s from ${users} users to ${target} (Ctrl+C to stop)`);

const fireTimer = setInterval(() => {
  // Cap concurrency so a hung server doesn't make the simulator itself explode.
  if (inFlight < rps * 10) void fireOne();
}, 1000 / rps);
const reportTimer = setInterval(report, 3000);

function stop(): void {
  clearInterval(fireTimer);
  clearInterval(reportTimer);
  report();
  process.exit(0);
}
process.on("SIGINT", stop);
if (durationSec > 0) setTimeout(stop, durationSec * 1000);
