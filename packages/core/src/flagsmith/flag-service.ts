import { type Logger, silentLogger } from "../logger.js";
import { type FlagsmithClient } from "./client.js";
import type { Environment, Feature, FlagState, Segment, SegmentRule } from "./types.js";

export interface RolloutState {
  environment: string;
  featureId: number;
  /** Whether the flag is on for everyone (environment default). */
  enabledForAll: boolean;
  /** Share of identities receiving the flag via FlagGuard's rollout segment (0-100). */
  percentage: number;
  /** Feature-specific segment FlagGuard uses for this environment, if created yet. */
  rolloutSegmentId: number | null;
}

/** Name of the feature-specific segment that carries the rollout percentage for one environment. */
export function rolloutSegmentName(environment: Pick<Environment, "name">): string {
  const slug = environment.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `flagguard-rollout-${slug}`;
}

/** Segment rules that match a stable `percentage`% of identities. */
export function percentageSplitRules(percentage: number): SegmentRule[] {
  return [
    {
      type: "ALL",
      rules: [
        {
          type: "ANY",
          conditions: [{ operator: "PERCENTAGE_SPLIT", property: "", value: String(percentage) }],
        },
      ],
    },
  ];
}

/** Extract the PERCENTAGE_SPLIT value from a segment created by {@link percentageSplitRules}. */
export function readPercentage(segment: Pick<Segment, "rules">): number | null {
  const stack = [...segment.rules];
  while (stack.length > 0) {
    const rule = stack.pop();
    if (!rule) break;
    const condition = rule.conditions?.find((c) => c.operator === "PERCENTAGE_SPLIT");
    if (condition?.value != null) {
      const value = Number(condition.value);
      return Number.isFinite(value) ? value : null;
    }
    stack.push(...(rule.rules ?? []));
  }
  return null;
}

function assertPercentage(percentage: number): void {
  if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
    throw new RangeError(
      `Rollout percentage must be an integer between 0 and 100, got ${percentage}`,
    );
  }
}

/**
 * Rollout primitives built on Flagsmith segments.
 *
 * A gradual rollout in one environment is modelled as:
 * - environment default **off**, plus
 * - a feature-specific segment with a `PERCENTAGE_SPLIT` rule, overridden to **on**.
 *
 * Flagsmith hashes identities consistently, so users who got the feature at 5%
 * keep it at 25%. At 100% the environment default is switched on.
 *
 * Every write is read-modify-write and preserves segment overrides that
 * FlagGuard does not own.
 */
export class FlagService {
  constructor(
    private readonly client: FlagsmithClient,
    private readonly projectId: number,
    private readonly logger: Logger = silentLogger,
  ) {}

  /** Return the feature with this name, creating it (disabled) if needed. Idempotent. */
  async ensureFeature(
    name: string,
    description: string,
  ): Promise<{ feature: Feature; created: boolean }> {
    const existing = await this.client.findFeatureByName(this.projectId, name);
    if (existing) return { feature: existing, created: false };

    const feature = await this.client.createFeature(this.projectId, {
      name,
      description,
      default_enabled: false,
    });
    this.logger.info("created feature flag", { feature: name, featureId: feature.id });
    return { feature, created: true };
  }

  async getRolloutState(environment: Environment, featureId: number): Promise<RolloutState> {
    const [state, segment] = await Promise.all([
      this.client.getFlagState(environment.api_key, featureId),
      this.findRolloutSegment(environment, featureId),
    ]);
    return this.toRolloutState(environment, featureId, state, segment);
  }

  /** Turn the flag on (non-production) or off for everyone in an environment. */
  async setEnabledForAll(
    environment: Environment,
    featureId: number,
    enabled: boolean,
  ): Promise<RolloutState> {
    await this.client.updateFlagState(environment.api_key, featureId, {
      environment_default: { enabled },
    });
    this.logger.info("set flag default", { environment: environment.name, featureId, enabled });
    return this.getRolloutState(environment, featureId);
  }

  /** Expose the flag to `percentage`% of identities in an environment. */
  async setRolloutPercentage(
    environment: Environment,
    featureId: number,
    percentage: number,
  ): Promise<RolloutState> {
    assertPercentage(percentage);

    const segment = await this.upsertRolloutSegment(environment, featureId, percentage);
    const state = await this.client.getFlagState(environment.api_key, featureId);

    const others = state.segment_overrides.filter((o) => o.segment.id !== segment.id);
    const ours = state.segment_overrides.find((o) => o.segment.id === segment.id);

    const updated = await this.client.updateFlagState(environment.api_key, featureId, {
      environment_default: { enabled: percentage === 100 },
      segment_overrides: [
        ...others,
        {
          segment: { id: segment.id },
          // Lowest priority: explicit team overrides (e.g. "internal users") still win.
          priority: ours?.priority ?? others.length,
          enabled: percentage > 0,
          value: ours?.value ?? null,
        },
      ],
    });

    this.logger.info("set rollout percentage", {
      environment: environment.name,
      featureId,
      percentage,
    });
    return this.toRolloutState(environment, featureId, updated, segment);
  }

  /**
   * Kill switch: turn the flag off for everyone in the environment, including
   * every segment override. Safe to call repeatedly.
   */
  async kill(environment: Environment, featureId: number): Promise<RolloutState> {
    const [state, segment] = await Promise.all([
      this.client.getFlagState(environment.api_key, featureId),
      this.findRolloutSegment(environment, featureId),
    ]);

    const updated = await this.client.updateFlagState(environment.api_key, featureId, {
      environment_default: { enabled: false },
      segment_overrides: state.segment_overrides.map((override) => ({
        ...override,
        enabled: false,
      })),
    });

    this.logger.warn("killed flag", { environment: environment.name, featureId });
    return this.toRolloutState(environment, featureId, updated, segment);
  }

  /* ---------------------------------- internals ---------------------------------- */

  private async findRolloutSegment(
    environment: Environment,
    featureId: number,
  ): Promise<Segment | null> {
    const name = rolloutSegmentName(environment);
    const segments = await this.client.listSegments(this.projectId, {
      query: name,
      includeFeatureSpecific: true,
    });
    return segments.find((s) => s.name === name && s.feature === featureId) ?? null;
  }

  private async upsertRolloutSegment(
    environment: Environment,
    featureId: number,
    percentage: number,
  ): Promise<Segment> {
    const request = {
      name: rolloutSegmentName(environment),
      description: `Managed by FlagGuard: gradual rollout in ${environment.name}. Do not edit by hand.`,
      feature: featureId,
      rules: percentageSplitRules(percentage),
    };
    const existing = await this.findRolloutSegment(environment, featureId);
    if (!existing) return this.client.createSegment(this.projectId, request);
    if (readPercentage(existing) === percentage) return existing;
    return this.client.updateSegment(this.projectId, existing.id, request);
  }

  private toRolloutState(
    environment: Environment,
    featureId: number,
    state: FlagState,
    segment: Segment | null,
  ): RolloutState {
    const enabledForAll = state.environment_default.enabled;
    const override = segment
      ? state.segment_overrides.find((o) => o.segment.id === segment.id)
      : undefined;

    let percentage = 0;
    if (enabledForAll) percentage = 100;
    else if (segment && override?.enabled) percentage = readPercentage(segment) ?? 0;

    return {
      environment: environment.name,
      featureId,
      enabledForAll,
      percentage,
      rolloutSegmentId: segment?.id ?? null,
    };
  }
}
