/**
 * deptend.dev — JSONB payload shapes
 *
 * These are opaque-to-Postgres JSONB blob shapes, not table row shapes —
 * there is no Drizzle-inferrable equivalent for them (a jsonb column's
 * contents can't be reverse-engineered from schema.ts the way a row's
 * columns can). They remain hand-written by design, and are wired into
 * schema.ts's jsonb column definitions via `.$type<T>()` so a `select()`
 * against those columns returns these exact shapes instead of `unknown`.
 *
 * Unlike the old db/types.ts row types (Repo, Dependency, Advisory, ...),
 * these were never part of the schema.ts/types.ts divergence problem —
 * moved here unchanged as part of ADR 0011.
 *
 * ADR: docs/adr/0011-schema-as-single-type-source.md
 */

/** One entry in an OSV "ranges" array */
export interface OsvVersionRange {
  type: "SEMVER" | "ECOSYSTEM" | "GIT";
  events: { introduced?: string; fixed?: string; last_affected?: string }[];
}

/** Raw scoring inputs stored on mission_scores for auditability */
export interface ImpactInputs {
  cvss_score: number | null;
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  /** true if the dep is a transitive dependency (resolved from lock file) */
  is_transitive: boolean;
  dep_type: "production" | "development" | "peer" | "optional";
  /** calendar days since the advisory was published */
  days_since_advisory: number | null;
}

export interface EcosystemValueInputs {
  repo_stars: number;
  open_issues_count: number;
  /**
   * Number of packages that depend on this repo's published package, if known.
   * Not populated as of Phase 2 (ADR 0006) — no free data source identified yet.
   * EcosystemValueScorer must treat null as "exclude and renormalize", never as 0.
   */
  downstream_dependents: number | null;
}

export interface EffortInputs {
  /** e.g. "major" | "minor" | "patch" */
  semver_bump: "major" | "minor" | "patch" | "unknown";
  has_migration_guide: boolean;
  /** signals parsed from changelog / release notes */
  breaking_change_signals: string[];
}

export interface ConfidenceFlags {
  no_lock_file?: boolean;
  cvss_score_missing?: boolean;
  fixed_version_unknown?: boolean;
  registry_metadata_incomplete?: boolean;
  /** Set when downstream_dependents is null — see ADR 0006 */
  downstream_dependents_unavailable?: boolean;
  /** Set when has_migration_guide / breaking_change_signals have no data source — see ADR 0007 */
  breaking_change_signals_unavailable?: boolean;
}
