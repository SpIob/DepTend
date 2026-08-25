/**
 * deptend.dev — Derived query/join types
 *
 * Convenience shapes for common query results (a mission joined with its
 * score) that don't map to a single table and so have no $inferSelect
 * equivalent. Built on top of schema.ts's inferred row types rather than
 * duplicating their fields.
 *
 * Moved from db/types.ts as part of ADR 0011. /app's data-fetching layer
 * is the primary consumer.
 */

import type {
  Advisory,
  Dependency,
  Ecosystem,
  Mission,
  MissionScore,
  Repo,
  Severity,
} from "./schema.js";

/**
 * Advisory subset shipped on mission list rows — narrower than the full
 * advisories table row on purpose. No list consumer renders the unbounded
 * blobs (details, affected_versions, and raw_data — the verbatim OSV
 * record) or the write-path bookkeeping columns (package_name, cvss_score,
 * summary, modified/created/updated timestamps), so selecting them only
 * multiplied every board's payload. The ranking keys (published_at, osv_id)
 * stay: rankMissions() and ADR 0031's SQL ordering both tie-break on them.
 */
export interface AdvisorySummary {
  id: string;
  osvId: string;
  source: Advisory["source"];
  ecosystem: Ecosystem;
  severity: Severity;
  fixedVersion: string | null;
  publishedAt: Date | null;
}

/** Mission with its score, source advisory, and owning repo — ready for dashboard rendering */
export interface MissionWithScore extends Mission {
  score: MissionScore;
  advisory: AdvisorySummary | null;
  dependency: Dependency | null;
  repo: Repo;
}

/** Open+claimed mission counts for one repo, bucketed by advisory severity. */
export type RepoMissionCounts = Record<Severity, number> & { total: number };

export const EMPTY_REPO_MISSION_COUNTS: RepoMissionCounts = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  unknown: 0,
  total: 0,
};

/**
 * Repo directory row (ADR 0027) — deliberately not shaped like
 * MissionWithScore's join: this powers a scan-then-drill-in page, so it
 * carries counts and the set of ecosystems present, not every mission's
 * full payload. isBookmarked is only meaningful when the query was run
 * for a signed-in user; false otherwise, not a tri-state.
 */
export interface RepoWithMissionSummary extends Repo {
  ecosystems: Ecosystem[];
  missionCounts: RepoMissionCounts;
  isBookmarked: boolean;
}
