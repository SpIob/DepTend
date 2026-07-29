/**
 * deptend.dev — Derived query/join types
 *
 * Convenience shapes for common query results (a mission joined with its
 * score, a repo joined with its latest ingestion run) that don't map to a
 * single table and so have no $inferSelect equivalent. Built on top of
 * schema.ts's inferred row types rather than duplicating their fields.
 *
 * Moved from db/types.ts as part of ADR 0011. /app's data-fetching layer
 * is the primary consumer.
 */

import type {
  Advisory,
  Dependency,
  Ecosystem,
  IngestionRun,
  Mission,
  MissionScore,
  Repo,
  Severity,
} from "./schema.js";

/** Mission with its score, source advisory, and owning repo — ready for dashboard rendering */
export interface MissionWithScore extends Mission {
  score: MissionScore;
  advisory: Advisory | null;
  dependency: Dependency | null;
  repo: Repo;
}

/** Repo with its latest ingestion run status */
export interface RepoWithIngestionStatus extends Repo {
  latestRun: Pick<IngestionRun, "status" | "startedAt" | "finishedAt" | "errorMessage"> | null;
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
