/**
 * deptend.dev — Database Types
 *
 * TypeScript interfaces and enums that exactly mirror the PostgreSQL schema
 * defined in schema.sql. These are plain types with no ORM dependency;
 * they can be used with any query layer (raw SQL, Drizzle, Kysely, etc.).
 *
 * Naming convention:
 *   - DB row types use PascalCase and match the SQL table name (singular).
 *   - Insert types (Omit id/timestamps) are suffixed with `Insert`.
 *   - All UUID fields are typed as `string` (postgres driver returns strings).
 *   - All JSONB fields are typed narrowly where the shape is known.
 */

// ---------------------------------------------------------------------------
// Enums (mirror PostgreSQL TYPE definitions in schema.sql)
// ---------------------------------------------------------------------------

export type IngestionStatus = "pending" | "running" | "complete" | "failed";

export type DepType = "production" | "development" | "peer" | "optional";

export type Ecosystem = "npm"; // 'pypi' added in Phase 6+

export type AdvisorySource = "osv" | "ghsa";

export type Severity = "critical" | "high" | "medium" | "low" | "unknown";

export type MissionType = "vulnerability_fix" | "dep_update" | "maintenance" | "license_issue";

export type MissionStatus = "open" | "claimed" | "resolved" | "dismissed";

export type EffortLabel = "trivial" | "low" | "medium" | "high";

export type ScoreConfidence = "high" | "medium" | "low";

// ---------------------------------------------------------------------------
// JSONB payload shapes
// ---------------------------------------------------------------------------

/** One entry in an OSV "ranges" array */
export interface OsvVersionRange {
  type: "SEMVER" | "ECOSYSTEM" | "GIT";
  events: { introduced?: string; fixed?: string; last_affected?: string }[];
}

/** Raw scoring inputs stored on mission_scores for auditability */
export interface ImpactInputs {
  cvss_score: number | null;
  severity: Severity;
  /** true if the dep is a transitive dependency (resolved from lock file) */
  is_transitive: boolean;
  dep_type: DepType;
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

// ---------------------------------------------------------------------------
// Table row types
// ---------------------------------------------------------------------------

export interface Repo {
  id: string;
  github_url: string;
  owner: string;
  name: string;
  default_branch: string;
  description: string | null;
  stars: number;
  open_issues_count: number;
  topics: string[];
  homepage_url: string | null;
  ingestion_status: IngestionStatus;
  last_ingested_at: Date | null;
  ingestion_error: string | null;
  submitted_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export type RepoInsert = Omit<
  Repo,
  "id" | "created_at" | "updated_at" | "last_ingested_at" | "ingestion_error"
>;

// -----------

export interface Dependency {
  id: string;
  repo_id: string;
  ecosystem: Ecosystem;
  package_name: string;
  version_spec: string;
  resolved_version: string | null;
  dep_type: DepType;
  latest_version: string | null;
  is_deprecated: boolean;
  deprecation_note: string | null;
  created_at: Date;
  updated_at: Date;
}

export type DependencyInsert = Omit<Dependency, "id" | "created_at" | "updated_at">;

// -----------

export interface Advisory {
  id: string;
  osv_id: string;
  source: AdvisorySource;
  ecosystem: Ecosystem;
  package_name: string;
  severity: Severity;
  cvss_score: number | null;
  summary: string;
  details: string | null;
  affected_versions: OsvVersionRange[];
  fixed_version: string | null;
  published_at: Date | null;
  modified_at: Date | null;
  raw_data: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export type AdvisoryInsert = Omit<Advisory, "id" | "created_at" | "updated_at">;

// -----------

export interface DependencyAdvisory {
  id: string;
  dependency_id: string;
  advisory_id: string;
  is_affected: boolean;
  match_method: "version_spec" | "resolved_version";
  created_at: Date;
}

export type DependencyAdvisoryInsert = Omit<DependencyAdvisory, "id" | "created_at">;

// -----------

export interface Mission {
  id: string;
  repo_id: string;
  title: string;
  description: string;
  action_hint: string | null;
  mission_type: MissionType;
  status: MissionStatus;
  advisory_id: string | null;
  dependency_id: string | null;
  claimed_by: string | null;
  claimed_at: Date | null;
  resolved_at: Date | null;
  dismissed_at: Date | null;
  dismiss_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export type MissionInsert = Omit<Mission, "id" | "created_at" | "updated_at">;

// -----------

export interface MissionScore {
  id: string;
  mission_id: string;
  impact_score: number;
  ecosystem_value_score: number;
  composite_score: number;
  effort_label: EffortLabel;
  impact_inputs: ImpactInputs;
  ecosystem_value_inputs: EcosystemValueInputs;
  effort_inputs: EffortInputs;
  confidence: ScoreConfidence;
  confidence_notes: string[] | null;
  confidence_flags: ConfidenceFlags;
  scoring_version: string;
  created_at: Date;
  updated_at: Date;
}

export type MissionScoreInsert = Omit<MissionScore, "id" | "created_at" | "updated_at">;

// -----------

export interface IngestionRun {
  id: string;
  repo_id: string;
  triggered_by: "cron" | "manual" | "submit";
  status: IngestionStatus;
  dependencies_found: number;
  advisories_fetched: number;
  missions_created: number;
  missions_updated: number;
  error_message: string | null;
  error_stack: string | null;
  started_at: Date;
  finished_at: Date | null;
  created_at: Date;
}

export type IngestionRunInsert = Omit<IngestionRun, "id" | "created_at">;

// ---------------------------------------------------------------------------
// Convenience join types (common query shapes)
// ---------------------------------------------------------------------------

/** Mission with its score and source advisory, ready for dashboard rendering */
export interface MissionWithScore extends Mission {
  score: MissionScore;
  advisory: Advisory | null;
  dependency: Dependency | null;
}

/** Repo with its latest ingestion run status */
export interface RepoWithIngestionStatus extends Repo {
  latest_run: Pick<IngestionRun, "status" | "started_at" | "finished_at" | "error_message"> | null;
}
