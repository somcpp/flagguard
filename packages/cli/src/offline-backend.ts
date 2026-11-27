import { type FlagBackend, FlagGuardError } from "@flagguard/core";

/**
 * Drives the demo shop's offline rollout (`PUT /admin/offline-rollout`) instead
 * of Flagsmith, so the whole agent loop can be demoed without an account.
 * Every environment maps onto the single running shop.
 */
export class OfflineShopBackend implements FlagBackend {
  readonly kind = "offline-shop";
  private readonly baseUrl: string;
  private readonly percentages = new Map<string, number>();

  constructor(
    baseUrl: string,
    private readonly options: { adminToken?: string; productionEnvironments: string[] },
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  ensureFlag(): Promise<{ created: boolean }> {
    return Promise.resolve({ created: false });
  }

  async getPercentage(environment: string): Promise<number> {
    if (!this.isShopEnvironment(environment)) return this.percentages.get(environment) ?? 0;
    const status = (await this.call("GET", "/api/status")) as { offlinePercentage: number | null };
    if (status.offlinePercentage === null) {
      throw new FlagGuardError(
        "OFFLINE_UNSUPPORTED",
        "The shop is evaluating flags with Flagsmith; drop --offline to manage it through Flagsmith",
      );
    }
    return status.offlinePercentage;
  }

  async setPercentage(environment: string, _flag: string, percentage: number): Promise<number> {
    if (!this.isShopEnvironment(environment)) {
      this.percentages.set(environment, percentage);
      return percentage;
    }
    await this.call("PUT", "/admin/offline-rollout", { percentage });
    return percentage;
  }

  async kill(environment: string, flag: string): Promise<void> {
    await this.setPercentage(environment, flag, 0);
  }

  /** The shop plays the production environment; other environments are simulated in memory. */
  private isShopEnvironment(environment: string): boolean {
    return this.options.productionEnvironments.some(
      (name) => name.toLowerCase() === environment.toLowerCase(),
    );
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(this.options.adminToken ? { Authorization: `Bearer ${this.options.adminToken}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    }).catch((cause: unknown) => {
      throw new FlagGuardError(
        "OFFLINE_UNREACHABLE",
        `Demo shop not reachable at ${this.baseUrl}`,
        {
          cause,
        },
      );
    });
    if (!response.ok) {
      throw new FlagGuardError(
        "OFFLINE_ERROR",
        `Demo shop ${method} ${path} failed with ${response.status}`,
      );
    }
    return response.json();
  }
}
