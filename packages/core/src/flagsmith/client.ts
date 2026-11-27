import { NotFoundError } from "../errors.js";
import { type HttpClient } from "./http.js";
import type {
  CreateFeatureRequest,
  CreateSegmentRequest,
  Environment,
  Feature,
  FlagState,
  Paginated,
  Project,
  Segment,
  UpdateFlagStateRequest,
} from "./types.js";

const V1 = "/api/v1";
/** Flagsmith's unified flag-state API; handles environments with and without v2 versioning. */
const FUTURE = "/api/__future__";

/** Safety valve against runaway pagination. */
const MAX_PAGES = 50;

/**
 * Typed wrapper around the Flagsmith Admin API endpoints FlagGuard uses.
 * Deliberately low-level: one method per endpoint, no business rules.
 */
export class FlagsmithClient {
  constructor(private readonly http: HttpClient) {}

  /* ---------------------------------- projects ---------------------------------- */

  getProject(projectId: number): Promise<Project> {
    return this.http.get<Project>(`${V1}/projects/${projectId}/`);
  }

  /* -------------------------------- environments -------------------------------- */

  listEnvironments(projectId: number): Promise<Environment[]> {
    return this.paginate<Environment>(`${V1}/environments/`, { project: projectId });
  }

  /* ---------------------------------- features ---------------------------------- */

  listFeatures(projectId: number, options: { search?: string } = {}): Promise<Feature[]> {
    return this.paginate<Feature>(`${V1}/projects/${projectId}/features/`, {
      search: options.search,
    });
  }

  /** Exact (case-sensitive) lookup by name; Flagsmith's `search` is a substring match. */
  async findFeatureByName(projectId: number, name: string): Promise<Feature | null> {
    const candidates = await this.listFeatures(projectId, { search: name });
    return candidates.find((feature) => feature.name === name) ?? null;
  }

  createFeature(projectId: number, request: CreateFeatureRequest): Promise<Feature> {
    return this.http.post<Feature>(`${V1}/projects/${projectId}/features/`, request);
  }

  updateFeature(
    projectId: number,
    featureId: number,
    patch: Partial<Pick<Feature, "description" | "is_archived" | "tags">>,
  ): Promise<Feature> {
    return this.http.patch<Feature>(`${V1}/projects/${projectId}/features/${featureId}/`, patch);
  }

  /* ---------------------------------- segments ---------------------------------- */

  listSegments(
    projectId: number,
    options: { query?: string; includeFeatureSpecific?: boolean } = {},
  ): Promise<Segment[]> {
    return this.paginate<Segment>(`${V1}/projects/${projectId}/segments/`, {
      q: options.query,
      include_feature_specific: options.includeFeatureSpecific,
    });
  }

  createSegment(projectId: number, request: CreateSegmentRequest): Promise<Segment> {
    return this.http.post<Segment>(`${V1}/projects/${projectId}/segments/`, request);
  }

  /** Full replace of a segment's definition (name, rules...). */
  updateSegment(
    projectId: number,
    segmentId: number,
    request: CreateSegmentRequest,
  ): Promise<Segment> {
    return this.http.put<Segment>(`${V1}/projects/${projectId}/segments/${segmentId}/`, request);
  }

  /* --------------------------------- flag state --------------------------------- */

  /** What a flag serves in one environment: default state plus segment overrides. */
  getFlagState(environmentKey: string, featureId: number): Promise<FlagState> {
    return this.http.get<FlagState>(
      `${FUTURE}/environments/${environmentKey}/features/${featureId}/`,
    );
  }

  updateFlagState(
    environmentKey: string,
    featureId: number,
    request: UpdateFlagStateRequest,
  ): Promise<FlagState> {
    return this.http.patch<FlagState>(
      `${FUTURE}/environments/${environmentKey}/features/${featureId}/`,
      request,
    );
  }

  /* ---------------------------------- helpers ---------------------------------- */

  async requireEnvironment(projectId: number, name: string): Promise<Environment> {
    const environments = await this.listEnvironments(projectId);
    const match = environments.find((env) => env.name.toLowerCase() === name.toLowerCase());
    if (!match) {
      throw new NotFoundError(
        `Environment "${name}" not found in project ${projectId}. Available: ${environments.map((e) => e.name).join(", ") || "none"}`,
      );
    }
    return match;
  }

  /**
   * Follow Flagsmith's `next` links. Also accepts endpoints that return a bare
   * array, since a few list endpoints are not paginated.
   */
  private async paginate<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
  ): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = this.http.url(path, { page_size: 100, ...query });
    for (let page = 0; next !== null; page++) {
      if (page >= MAX_PAGES) throw new Error(`Pagination limit exceeded for ${path}`);
      const response: Paginated<T> | T[] = await this.http.get(next);
      if (Array.isArray(response)) return response;
      items.push(...response.results);
      next = response.next;
    }
    return items;
  }
}
