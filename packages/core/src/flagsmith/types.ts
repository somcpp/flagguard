/**
 * Subset of the Flagsmith Admin API models that FlagGuard relies on.
 * Field names mirror the API (snake_case) so responses map 1:1.
 * Source: https://api.flagsmith.com/api/v1/swagger.json
 */

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface Project {
  id: number;
  uuid: string;
  name: string;
  organisation: number;
}

export interface Environment {
  id: number;
  uuid: string;
  name: string;
  /** Client-side environment key; also used to address the environment in many endpoints. */
  api_key: string;
  project: number;
  use_v2_feature_versioning: boolean;
}

export interface Feature {
  id: number;
  uuid: string;
  name: string;
  description: string | null;
  default_enabled: boolean;
  initial_value: string | null;
  type: "STANDARD" | "MULTIVARIATE" | "";
  is_archived: boolean;
  project: number;
  tags: number[];
  created_date: string;
}

export interface CreateFeatureRequest {
  name: string;
  description?: string;
  default_enabled?: boolean;
  initial_value?: string | null;
  tags?: number[];
  is_server_key_only?: boolean;
}

export type SegmentRuleType = "ALL" | "ANY" | "NONE";

export interface SegmentCondition {
  id?: number;
  operator: string;
  property?: string | null;
  value?: string | null;
  description?: string | null;
}

export interface SegmentRule {
  id?: number;
  type: SegmentRuleType;
  rules?: SegmentRule[];
  conditions?: SegmentCondition[];
}

export interface Segment {
  id: number;
  uuid: string;
  name: string;
  description: string | null;
  project: number;
  /** When set, the segment is scoped to a single feature. */
  feature: number | null;
  rules: SegmentRule[];
}

export interface CreateSegmentRequest {
  name: string;
  description?: string;
  feature?: number | null;
  rules: SegmentRule[];
}

/* ---- "__future__" unified flag-state API (works with and without v2 versioning) ---- */

export type FlagValueType = "string" | "integer" | "boolean";

export interface FlagValue {
  type: FlagValueType;
  value: string;
}

/** Multivariate weight. Only valid on multivariate features. */
export interface FlagVariant {
  id: number;
  weight: number;
}

export interface SegmentOverride {
  segment: { id: number };
  priority: number;
  enabled: boolean;
  value: FlagValue | null;
  variants?: FlagVariant[];
}

export interface FlagState {
  environment_default: {
    enabled: boolean;
    value: FlagValue | null;
    variants?: FlagVariant[];
  };
  segment_overrides: SegmentOverride[];
}

export interface SegmentOverrideRequest {
  segment: { id: number };
  priority?: number;
  enabled?: boolean;
  value?: FlagValue | null;
  /** Must be omitted for standard (non-multivariate) features, even when empty. */
  variants?: FlagVariant[];
}

export interface UpdateFlagStateRequest {
  environment_default?: { enabled?: boolean; value?: FlagValue | null };
  segment_overrides?: SegmentOverrideRequest[];
}
