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

import type { Advisory, Dependency, IngestionRun, Mission, MissionScore, Repo } from "./schema.js";

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
