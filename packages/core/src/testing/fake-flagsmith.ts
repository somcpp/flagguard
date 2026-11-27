import type { FetchLike } from "../flagsmith/http.js";
import type {
  CreateFeatureRequest,
  CreateSegmentRequest,
  Environment,
  Feature,
  FlagState,
  Segment,
  UpdateFlagStateRequest,
} from "../flagsmith/types.js";

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

/**
 * In-memory stand-in for the subset of the Flagsmith Admin API that FlagGuard
 * uses. Powers unit tests and the offline demo mode, so the agent can be
 * exercised end-to-end without a Flagsmith account.
 */
export class FakeFlagsmith {
  readonly projectId: number;
  readonly environments: Environment[] = [];
  readonly features: Feature[] = [];
  readonly segments: Segment[] = [];
  readonly requests: RecordedRequest[] = [];
  /** `${environmentKey}:${featureId}` → state */
  private readonly states = new Map<string, FlagState>();
  private nextId = 1000;

  constructor(options: { projectId?: number; environments?: string[] } = {}) {
    this.projectId = options.projectId ?? 1;
    for (const name of options.environments ?? ["Development", "Staging", "Production"]) {
      const id = this.id();
      this.environments.push({
        id,
        uuid: `env-${id}`,
        name,
        api_key: `env_${name.toLowerCase()}`,
        project: this.projectId,
        use_v2_feature_versioning: false,
      });
    }
  }

  environment(name: string): Environment {
    const env = this.environments.find((e) => e.name === name);
    if (!env) throw new Error(`No fake environment ${name}`);
    return env;
  }

  state(environmentKey: string, featureId: number): FlagState {
    const key = `${environmentKey}:${featureId}`;
    let state = this.states.get(key);
    if (!state) {
      const feature = this.features.find((f) => f.id === featureId);
      state = {
        environment_default: { enabled: feature?.default_enabled ?? false, value: null },
        segment_overrides: [],
      };
      this.states.set(key, state);
    }
    return state;
  }

  /** `fetch`-compatible handler to inject into {@link HttpClient}. */
  readonly fetch: FetchLike = (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path: url.pathname, body });
    return Promise.resolve(this.route(method, url, body));
  };

  private route(method: string, url: URL, body: unknown): Response {
    const p = url.pathname;
    const pid = this.projectId;
    let m: RegExpMatchArray | null;

    if (method === "GET" && p === "/api/v1/environments/") {
      return page(
        this.environments.filter((e) => e.project === Number(url.searchParams.get("project"))),
      );
    }

    if (p === `/api/v1/projects/${pid}/features/`) {
      if (method === "GET") {
        const search = url.searchParams.get("search") ?? "";
        return page(this.features.filter((f) => f.name.includes(search)));
      }
      if (method === "POST") {
        const req = body as CreateFeatureRequest;
        if (this.features.some((f) => f.name === req.name)) {
          return json(400, { name: ["Feature with that name already exists."] });
        }
        const id = this.id();
        const feature: Feature = {
          id,
          uuid: `feat-${id}`,
          name: req.name,
          description: req.description ?? null,
          default_enabled: req.default_enabled ?? false,
          initial_value: req.initial_value ?? null,
          type: "STANDARD",
          is_archived: false,
          project: pid,
          tags: req.tags ?? [],
          created_date: new Date(0).toISOString(),
        };
        this.features.push(feature);
        return json(201, feature);
      }
    }

    if (
      (m = new RegExp(`^/api/v1/projects/${pid}/features/(\\d+)/$`).exec(p)) &&
      method === "PATCH"
    ) {
      const feature = this.features.find((f) => f.id === Number(m?.[1]));
      if (!feature) return json(404, { detail: "Not found." });
      Object.assign(feature, body);
      return json(200, feature);
    }

    if (p === `/api/v1/projects/${pid}/segments/`) {
      if (method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const includeFeatureSpecific = url.searchParams.get("include_feature_specific") === "true";
        return page(
          this.segments.filter(
            (s) => s.name.includes(q) && (includeFeatureSpecific || s.feature === null),
          ),
        );
      }
      if (method === "POST") {
        const req = body as CreateSegmentRequest;
        const id = this.id();
        const segment: Segment = {
          id,
          uuid: `seg-${id}`,
          name: req.name,
          description: req.description ?? null,
          project: pid,
          feature: req.feature ?? null,
          rules: req.rules,
        };
        this.segments.push(segment);
        return json(201, segment);
      }
    }

    if (
      (m = new RegExp(`^/api/v1/projects/${pid}/segments/(\\d+)/$`).exec(p)) &&
      method === "PUT"
    ) {
      const segment = this.segments.find((s) => s.id === Number(m?.[1]));
      if (!segment) return json(404, { detail: "Not found." });
      const req = body as CreateSegmentRequest;
      Object.assign(segment, {
        name: req.name,
        description: req.description ?? null,
        feature: req.feature ?? null,
        rules: req.rules,
      });
      return json(200, segment);
    }

    if ((m = /^\/api\/__future__\/environments\/([^/]+)\/features\/(\d+)\/$/.exec(p))) {
      const envKey = m[1] ?? "";
      const featureId = Number(m[2]);
      if (!this.environments.some((e) => e.api_key === envKey))
        return json(404, { detail: "Not found." });
      if (!this.features.some((f) => f.id === featureId))
        return json(404, { detail: "Not found." });
      const state = this.state(envKey, featureId);
      if (method === "GET") return json(200, state);
      if (method === "PATCH") {
        const req = body as UpdateFlagStateRequest;
        if (req.environment_default) {
          state.environment_default = { ...state.environment_default, ...req.environment_default };
        }
        if (req.segment_overrides) {
          state.segment_overrides = req.segment_overrides.map((o, index) => ({
            segment: { id: o.segment.id },
            priority: o.priority ?? index,
            enabled: o.enabled ?? false,
            value: o.value ?? null,
          }));
        }
        return json(200, state);
      }
    }

    return json(404, { detail: `Fake Flagsmith has no route for ${method} ${p}` });
  }

  private id(): number {
    return this.nextId++;
  }
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function page(results: unknown[]): Response {
  return json(200, { count: results.length, next: null, previous: null, results });
}
