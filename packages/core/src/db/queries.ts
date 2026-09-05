/**
 * Mission read queries — core join + fetch-everything path
 *
 * Lives in packages/core, not /app, on purpose: every other DB write path
 * in this project (IngestionWriter, MissionWriter) also lives here, and
 * keeping read queries in the same place means there is one program/
 * project context building Drizzle queries against schema.ts, not two.
 *
 * That turned out not to be a style preference — it's load-bearing. A
 * version of this query built directly in /app (importing `missions` etc.
 * via the `@deptend/core/db/schema.js` subpath, then querying with /app's
 * own `db` client) type-checks fine under `tsc --noEmit` but fails under
 * `eslint --max-warnings 0`'s typed linting: every property read off a
 * joined row resolves to an unresolvable "error" type, even for a single-
 * table `db.select().from(missions)` with no join at all. Root cause:
 * eslint.config.mjs's parserOptions.project lists both app/tsconfig.json
 * and packages/core/tsconfig.json for typed linting — so the `missions`
 * table has two live instantiations for the type-checker (packages/core's
 * own program compiling schema.ts from source, and app's program
 * consuming the compiled dist/db/schema.d.ts), and Drizzle's branded
 * generic types don't unify across them. Confirmed via bisection down to
 * the single-table, no-join, no-alias case — not fixable by simplifying
 * the query. Building the query here instead, where schema.ts is only
 * ever compiled by one program, sidesteps it entirely.
 *
 * Paginated board queries moved to board-queries.ts (ADR 0031).
 * Directory/count queries moved to directory-queries.ts (ADR 0046/0053).
 */

import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema.js";
import { advisories, dependencies, missions, missionScores, repos } from "./schema.js";
import type { MissionStatus } from "./schema.js";
import { rankMissions, type RankableMission } from "../scorer/ranking.js";
import type { AdvisorySummary, MissionWithScore } from "./query-types.js";

export type ReadonlyDb = NeonHttpDatabase<typeof schema>;

/**
 * Advisory columns the list rows actually ship (see AdvisorySummary in
 * query-types.ts for what's left out and why). The key order here is the
 * SELECT-list order the driver maps positional rows against — tests' joinedRow()
 * fixture must match it.
 */
const advisoryListSelection = {
  id: advisories.id,
  osvId: advisories.osvId,
  source: advisories.source,
  ecosystem: advisories.ecosystem,
  severity: advisories.severity,
  fixedVersion: advisories.fixedVersion,
  publishedAt: advisories.publishedAt,
};

/**
 * The five-table join behind every mission-listing read: missions with
 * score, advisory, dependency, and owning repo attached. Shared by
 * getMissionsWithScoresByStatus() (fetch-everything-then-rank-in-JS) and
 * board-queries.ts (SQL-side filter/order/paginate) so the two paths
 * can't drift apart.
 *
 * The return type is Drizzle's chained query builder, whose branded generics
 * are not practically writable by hand — same family of typed-linting
 * friction ADR 0012 documents for cross-tsconfig checking. The inferred
 * type is still fully checked at every call site.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function missionJoinRows(db: ReadonlyDb) {
  return db
    .select({
      mission: missions,
      score: missionScores,
      advisory: advisoryListSelection,
      dependency: dependencies,
      repo: repos,
    })
    .from(missions)
    .innerJoin(missionScores, eq(missionScores.missionId, missions.id))
    .innerJoin(repos, eq(missions.repoId, repos.id))
    .leftJoin(advisories, eq(missions.advisoryId, advisories.id))
    .leftJoin(dependencies, eq(missions.dependencyId, dependencies.id));
}

interface MissionJoinRow {
  mission: typeof missions.$inferSelect;
  score: typeof missionScores.$inferSelect;
  /** Left-join projection — every field individually nullable, per Drizzle. */
  advisory: { [K in keyof typeof advisoryListSelection]: unknown } | null;
  dependency: typeof dependencies.$inferSelect | null;
  repo: typeof repos.$inferSelect;
}

export function toMissionWithScore(row: MissionJoinRow): MissionWithScore {
  // A left-joined partial selection types every field as nullable, but at
  // runtime the row is either a full advisory (id present => the join hit a
  // real row, so each column holds its schema-declared value) or all-null.
  // Normalizing to AdvisorySummary | null here keeps every downstream
  // consumer's `advisory === null` / optional-chaining shape unchanged.
  const advisory =
    row.advisory !== null && row.advisory.id !== null ? (row.advisory as AdvisorySummary) : null;
  return {
    ...row.mission,
    score: row.score,
    advisory,
    dependency: row.dependency,
    repo: row.repo,
  };
}

/**
 * Builds a read-only (neon-http, no transactions) DB client. Callers pass
 * their own DATABASE_URL — this file doesn't read process.env itself, so
 * it stays usable from any runtime (Next.js server components, a future
 * API route, a script) without assuming how env vars get there.
 */
export function createReadonlyDb(databaseUrl: string): ReadonlyDb {
  return drizzle(neon(databaseUrl), { schema });
}

/**
 * Shared implementation behind getRepoMissionsWithScores() below — same
 * join, same ranking; status filter always applies, repoId narrows to one
 * repo when passed (ADR 0027).
 *
 * The former board-wide variant (getOpenMissionsWithScores, all repos,
 * status "open" only) was removed: the board's read path is
 * getBoardMissionsWithScoresPage (board-queries.ts, ADR 0031) — SQL-side
 * filtering/sorting/pagination — and nothing else ever consumed the
 * fetch-everything shape.
 */
async function getMissionsWithScoresByStatus(
  db: ReadonlyDb,
  statuses: readonly MissionStatus[],
  repoId?: string,
): Promise<MissionWithScore[]> {
  const rows = await missionJoinRows(db).where(
    repoId === undefined
      ? inArray(missions.status, statuses)
      : and(inArray(missions.status, statuses), eq(missions.repoId, repoId)),
  );

  const ranked = rankMissions(
    rows.map((row): RankableMission & { mission: MissionWithScore } => {
      const mission = toMissionWithScore(row);
      return {
        mission,
        // Not mission.createdAt — see ADR 0018. Missions from the same
        // ingestion run share one transaction-scoped Postgres now(), so
        // createdAt doesn't actually discriminate between them.
        tie_break: {
          published_at: mission.advisory?.publishedAt ?? null,
          // mission.advisory is nullable (future non-advisory mission types
          // per Phase 2 scope) — fall back to the mission's own id, which is
          // always present and unique, same role osv_id plays when there is
          // an advisory.
          osv_id: mission.advisory?.osvId ?? mission.id,
        },
        score: {
          composite_score: mission.score.compositeScore,
          effort_label: mission.score.effortLabel,
        },
      };
    }),
  );

  return ranked.map((r) => r.mission);
}

/**
 * Open + claimed missions for one repo, ranked by rankMissions() —
 * composite score, effort as tie-breaker, same algorithm used everywhere
 * else in this project — the query behind /repo/[owner]/[name] (ADR 0027).
 * Scoped to a single repo_id so query cost and payload size are bounded by
 * one repo's mission count, not the whole board's.
 */
export async function getRepoMissionsWithScores(
  db: ReadonlyDb,
  repoId: string,
): Promise<MissionWithScore[]> {
  return getMissionsWithScoresByStatus(db, ["open", "claimed"], repoId);
}

// Re-export types that /app and internal modules import from this module.
// These types are defined in query-types.ts but were historically imported
// from queries.js — keep the import surface stable.
export type {
  BoardFilters,
  BoardFacets,
  BoardPage,
  BoardSortMode,
  RepoDirectorySummary,
  SkippedRepo,
  RepoDirectoryOptions,
  RepoWithMissionSummary,
  MissionWithScore,
  AdvisorySummary,
  RepoMissionCounts,
} from "./query-types.js";

// Re-export the paginated board functions from their new home so existing
// imports from @deptend/core/db/queries.js continue working without changes.
// The actual implementations live in board-queries.ts and directory-queries.ts.
export {
  BOARD_PAGE_SIZE,
  getBoardMissionsWithScoresPage,
  getRepoBoardPage,
} from "./board-queries.js";

export {
  getRepoDirectorySummary,
  getRepoEcosystems,
  getRepoDirectoryBase,
  getIndexedRepoCount,
  getTotalRepoCount,
  getSkippedRepos,
} from "./directory-queries.js";
