/**
 * Mission read queries
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
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema.js";
import { advisories, dependencies, missions, missionScores, repos } from "./schema.js";
import type { MissionStatus } from "./schema.js";
import { rankMissions, type RankableMission } from "../scorer/ranking.js";
import {
  EMPTY_REPO_MISSION_COUNTS,
  type MissionWithScore,
  type RepoMissionCounts,
  type RepoWithMissionSummary,
} from "./query-types.js";
import { getBookmarkedRepoIds } from "./bookmarks.js";

export type ReadonlyDb = NeonHttpDatabase<typeof schema>;

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
 * Shared implementation behind getOpenMissionsWithScores(),
 * getBoardMissionsWithScores(), and getRepoMissionsWithScores() below —
 * same join, same ranking; status filter always applies, repoId narrows
 * to one repo when passed (ADR 0027) and is left off entirely otherwise
 * so the board-wide callers are unchanged.
 */
async function getMissionsWithScoresByStatus(
  db: ReadonlyDb,
  statuses: readonly MissionStatus[],
  repoId?: string,
): Promise<MissionWithScore[]> {
  const rows = await db
    .select({
      mission: missions,
      score: missionScores,
      advisory: advisories,
      dependency: dependencies,
      repo: repos,
    })
    .from(missions)
    .innerJoin(missionScores, eq(missionScores.missionId, missions.id))
    .innerJoin(repos, eq(missions.repoId, repos.id))
    .leftJoin(advisories, eq(missions.advisoryId, advisories.id))
    .leftJoin(dependencies, eq(missions.dependencyId, dependencies.id))
    .where(
      repoId === undefined
        ? inArray(missions.status, statuses)
        : and(inArray(missions.status, statuses), eq(missions.repoId, repoId)),
    );

  const withScores: MissionWithScore[] = rows.map((row) => ({
    ...row.mission,
    score: row.score,
    advisory: row.advisory,
    dependency: row.dependency,
    repo: row.repo,
  }));

  const ranked = rankMissions(
    withScores.map((mission): RankableMission & { mission: MissionWithScore } => ({
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
    })),
  );

  return ranked.map((r) => r.mission);
}

/**
 * All open missions, ranked highest-priority first (rankMissions() —
 * composite score, effort as tie-breaker, same algorithm used everywhere
 * else in this project).
 *
 * "Open" excludes claimed/resolved/dismissed missions — this is "what to
 * fix next," not "everything that was ever found."
 */
export async function getOpenMissionsWithScores(db: ReadonlyDb): Promise<MissionWithScore[]> {
  return getMissionsWithScoresByStatus(db, ["open"]);
}

/**
 * Open + claimed missions, ranked the same way as
 * getOpenMissionsWithScores() above. This is what the Phase 5 public
 * rescue board renders: claimed missions stay visible (marked claimed,
 * not actionable by anyone but their claimant) so the board also answers
 * "what's already being worked on," not just "what's left." Resolved and
 * dismissed missions are excluded — no UI surfaces either state yet.
 */
export async function getBoardMissionsWithScores(db: ReadonlyDb): Promise<MissionWithScore[]> {
  return getMissionsWithScoresByStatus(db, ["open", "claimed"]);
}

/**
 * Open + claimed missions for one repo, ranked the same way as
 * getBoardMissionsWithScores() — the query behind /repo/[owner]/[name]
 * (ADR 0027). Scoped to a single repo_id so query cost and payload size
 * are bounded by one repo's mission count, not the whole board's.
 */
export async function getRepoMissionsWithScores(
  db: ReadonlyDb,
  repoId: string,
): Promise<MissionWithScore[]> {
  return getMissionsWithScoresByStatus(db, ["open", "claimed"], repoId);
}

/** Count of repos that have completed at least one ingestion run. */
export async function getIndexedRepoCount(db: ReadonlyDb): Promise<number> {
  const rows = await db
    .select({ id: repos.id })
    .from(repos)
    .where(eq(repos.ingestionStatus, "complete"));
  return rows.length;
}

/**
 * Count of all submitted repos, regardless of ingestion status. This is
 * what the MVP repo cap actually limits — matches the count submitRepo()
 * checks server-side (packages/core/src/db/repos.ts). Distinct from
 * getIndexedRepoCount() above, which is the public-facing "successfully
 * processed" stat, not the submission cap.
 */
export async function getTotalRepoCount(db: ReadonlyDb): Promise<number> {
  const rows = await db.select({ id: repos.id }).from(repos);
  return rows.length;
}

export interface SkippedRepo {
  owner: string;
  name: string;
  /** Why NpmIngestor couldn't find/parse a manifest — see writer.ts. */
  reason: string | null;
}

/**
 * Repos whose most recent ingestion completed without error but found no
 * analyzable package.json (status: "skipped" — see the ingestion_status
 * enum's own comment in schema.ts). Still counts against the repo cap via
 * getTotalRepoCount() above; excluded from getIndexedRepoCount() since
 * nothing was actually indexed. Small enough a list that the dashboard
 * can show it in full — no pagination.
 */
/**
 * Distinct ecosystems present in one repo — same source data
 * getReposWithMissionSummary() uses for the directory grid, just scoped to
 * a single repo_id instead of grouped across all of them. Backs the
 * ecosystem badges on /repo/[owner]/[name]'s header.
 */
export async function getRepoEcosystems(
  db: ReadonlyDb,
  repoId: string,
): Promise<schema.Ecosystem[]> {
  const rows = await db
    .selectDistinct({ ecosystem: dependencies.ecosystem })
    .from(dependencies)
    .where(eq(dependencies.repoId, repoId));
  return rows.map((row) => row.ecosystem);
}

export async function getSkippedRepos(db: ReadonlyDb): Promise<SkippedRepo[]> {
  return db
    .select({ owner: repos.owner, name: repos.name, reason: repos.ingestionError })
    .from(repos)
    .where(eq(repos.ingestionStatus, "skipped"));
}

/**
 * One row per repo for the directory page (ADR 0027) — mission counts by
 * severity and the set of ecosystems present, without shipping every
 * mission's full payload the way getBoardMissionsWithScores() does.
 *
 * Deliberately four small, independently-bounded queries assembled in
 * application code rather than one mega-join: a single query joining
 * missions/advisories/dependencies against repos would multiply rows in
 * exactly the way this function exists to avoid. Every one of the four is
 * bounded by repo count (the MVP cap) or (repo × severity) pairs, not by
 * total mission count — matching the reasoning in this file's own header
 * comment about why these queries live in packages/core in the first
 * place: correctness and cost here matter more than a single round trip.
 *
 * userLogin is optional — omit it (e.g. a signed-out visitor) and every
 * row's isBookmarked is simply false, not a separate tri-state.
 */
export async function getReposWithMissionSummary(
  db: ReadonlyDb,
  userLogin?: string,
): Promise<RepoWithMissionSummary[]> {
  const [repoRows, ecosystemRows, severityRows, bookmarkedRepoIds] = await Promise.all([
    db.select().from(repos),
    db
      .selectDistinct({ repoId: dependencies.repoId, ecosystem: dependencies.ecosystem })
      .from(dependencies),
    db
      .select({
        repoId: missions.repoId,
        severity: advisories.severity,
        count: sql<number>`count(*)::int`,
      })
      .from(missions)
      .innerJoin(advisories, eq(missions.advisoryId, advisories.id))
      .where(inArray(missions.status, ["open", "claimed"]))
      .groupBy(missions.repoId, advisories.severity),
    userLogin === undefined
      ? Promise.resolve(new Set<string>())
      : getBookmarkedRepoIds(db, userLogin),
  ]);

  const ecosystemsByRepo = new Map<string, Set<schema.Ecosystem>>();
  for (const row of ecosystemRows) {
    const set = ecosystemsByRepo.get(row.repoId) ?? new Set<schema.Ecosystem>();
    set.add(row.ecosystem);
    ecosystemsByRepo.set(row.repoId, set);
  }

  const countsByRepo = new Map<string, RepoMissionCounts>();
  for (const row of severityRows) {
    const counts = countsByRepo.get(row.repoId) ?? { ...EMPTY_REPO_MISSION_COUNTS };
    counts[row.severity] += row.count;
    counts.total += row.count;
    countsByRepo.set(row.repoId, counts);
  }

  return repoRows.map((repo) => ({
    ...repo,
    ecosystems: Array.from(ecosystemsByRepo.get(repo.id) ?? []),
    missionCounts: countsByRepo.get(repo.id) ?? EMPTY_REPO_MISSION_COUNTS,
    isBookmarked: bookmarkedRepoIds.has(repo.id),
  }));
}
