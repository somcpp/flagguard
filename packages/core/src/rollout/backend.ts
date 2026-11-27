import { NotFoundError } from "../errors.js";
import { type FlagsmithClient } from "../flagsmith/client.js";
import { type FlagService } from "../flagsmith/flag-service.js";
import type { Environment, Feature } from "../flagsmith/types.js";

/**
 * What the rollout engine needs from a feature-flag system, addressed by
 * flag *name* and environment *name* (as written in flagguard.yml).
 */
export interface FlagBackend {
  readonly kind: string;
  /** Create the flag (disabled everywhere) if it does not exist. */
  ensureFlag(flag: string, description: string): Promise<{ created: boolean }>;
  getPercentage(environment: string, flag: string): Promise<number>;
  setPercentage(environment: string, flag: string, percentage: number): Promise<number>;
  /** Turn the flag fully off in the environment, including any overrides. */
  kill(environment: string, flag: string): Promise<void>;
}

/** {@link FlagBackend} on top of the Flagsmith Admin API. */
export class FlagsmithBackend implements FlagBackend {
  readonly kind = "flagsmith";
  private environments: Promise<Environment[]> | null = null;
  private readonly features = new Map<string, Feature>();

  constructor(
    private readonly client: FlagsmithClient,
    private readonly flags: FlagService,
    private readonly projectId: number,
  ) {}

  async ensureFlag(flag: string, description: string): Promise<{ created: boolean }> {
    const { feature, created } = await this.flags.ensureFeature(flag, description);
    this.features.set(flag, feature);
    return { created };
  }

  async getPercentage(environment: string, flag: string): Promise<number> {
    const [env, feature] = await Promise.all([this.environment(environment), this.feature(flag)]);
    return (await this.flags.getRolloutState(env, feature.id)).percentage;
  }

  async setPercentage(environment: string, flag: string, percentage: number): Promise<number> {
    const [env, feature] = await Promise.all([this.environment(environment), this.feature(flag)]);
    return (await this.flags.setRolloutPercentage(env, feature.id, percentage)).percentage;
  }

  async kill(environment: string, flag: string): Promise<void> {
    const [env, feature] = await Promise.all([this.environment(environment), this.feature(flag)]);
    await this.flags.kill(env, feature.id);
  }

  private async environment(name: string): Promise<Environment> {
    this.environments ??= this.client.listEnvironments(this.projectId);
    const environments = await this.environments;
    const match = environments.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (!match) {
      throw new NotFoundError(
        `Flagsmith environment "${name}" not found. Available: ${environments.map((e) => e.name).join(", ")}`,
      );
    }
    return match;
  }

  private async feature(name: string): Promise<Feature> {
    const cached = this.features.get(name);
    if (cached) return cached;
    const feature = await this.client.findFeatureByName(this.projectId, name);
    if (!feature) throw new NotFoundError(`Flag "${name}" does not exist in Flagsmith yet`);
    this.features.set(name, feature);
    return feature;
  }
}

/** In-memory backend for tests and dry runs. */
export class MemoryFlagBackend implements FlagBackend {
  readonly kind = "memory";
  readonly flags = new Set<string>();
  readonly percentages = new Map<string, number>();
  readonly calls: string[] = [];

  ensureFlag(flag: string): Promise<{ created: boolean }> {
    const created = !this.flags.has(flag);
    this.flags.add(flag);
    this.calls.push(`ensure ${flag}`);
    return Promise.resolve({ created });
  }

  getPercentage(environment: string, flag: string): Promise<number> {
    return Promise.resolve(this.percentages.get(`${environment}/${flag}`) ?? 0);
  }

  setPercentage(environment: string, flag: string, percentage: number): Promise<number> {
    this.percentages.set(`${environment}/${flag}`, percentage);
    this.calls.push(`set ${environment}/${flag}=${percentage}`);
    return Promise.resolve(percentage);
  }

  kill(environment: string, flag: string): Promise<void> {
    this.percentages.set(`${environment}/${flag}`, 0);
    this.calls.push(`kill ${environment}/${flag}`);
    return Promise.resolve();
  }
}
