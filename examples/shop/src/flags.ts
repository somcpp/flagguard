import { createHash } from "node:crypto";
import { DefaultFlag, Flagsmith } from "flagsmith-nodejs";

/** How the shop decides which checkout a user gets. */
export interface FlagProvider {
  readonly mode: "flagsmith" | "offline";
  isEnabled(flag: string, userId: string): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Evaluates flags with the Flagsmith Node SDK in **local evaluation** mode: the
 * environment document (including FlagGuard's percentage-split segments) is
 * polled every few seconds and evaluated in-process, so checkout latency does
 * not depend on a network round-trip and a kill switch propagates within one
 * refresh interval.
 */
export class FlagsmithFlagProvider implements FlagProvider {
  readonly mode = "flagsmith" as const;
  private readonly client: Flagsmith;

  constructor(options: { serverKey: string; apiUrl?: string; refreshSeconds: number }) {
    if (!options.serverKey.startsWith("ser.")) {
      throw new Error(
        "FLAGSMITH_SERVER_KEY must be a server-side key (starts with 'ser.'); local evaluation needs it",
      );
    }
    this.client = new Flagsmith({
      environmentKey: options.serverKey,
      ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
      enableLocalEvaluation: true,
      environmentRefreshIntervalSeconds: options.refreshSeconds,
      // If Flagsmith is unreachable, serve the old code path. Failing safe is the point.
      defaultFlagHandler: () => new DefaultFlag(undefined, false),
    });
  }

  async isEnabled(flag: string, userId: string): Promise<boolean> {
    const flags = await this.client.getIdentityFlags(userId);
    return flags.isFeatureEnabled(flag);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/**
 * Stable bucket in [0, 100) for a user and flag. Same idea as Flagsmith's
 * percentage split: a user's bucket never changes, so raising the percentage
 * only adds users.
 */
export function bucketOf(flag: string, userId: string): number {
  const digest = createHash("sha1").update(`${flag}:${userId}`).digest();
  return (digest.readUInt32BE(0) % 10_000) / 100;
}

/** Flagsmith-free provider for running the demo without an account. */
export class OfflineFlagProvider implements FlagProvider {
  readonly mode = "offline" as const;
  private readonly percentages = new Map<string, number>();

  constructor(private readonly defaultPercentage = 0) {}

  setPercentage(flag: string, percentage: number): void {
    if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
      throw new RangeError("percentage must be an integer between 0 and 100");
    }
    this.percentages.set(flag, percentage);
  }

  getPercentage(flag: string): number {
    return this.percentages.get(flag) ?? this.defaultPercentage;
  }

  isEnabled(flag: string, userId: string): Promise<boolean> {
    return Promise.resolve(bucketOf(flag, userId) < this.getPercentage(flag));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
