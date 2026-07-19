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

import { eq } from "drizzle-orm";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema.js";
import { advisories, dependencies, missions, missionScores, repos } from "./schema.js";
import { rankMissions, type RankableMission } from "../scorer/ranking.js";
import type { MissionWithScore } from "./query-types.js";

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
 * All open missions, ranked highest-priority first (rankMissions() —
 * composite score, effort as tie-breaker, same algorithm used everywhere
 * else in this project).
 *
 * "Open" excludes claimed/resolved/dismissed missions — Phase 3 has no
 * claim flow yet (that's Phase 5), so in practice every mission returned
 * here is untouched, but the filter is the correct long-term semantic:
 * this is "what to fix next," not "everything that was ever found."
 */
export async function getOpenMissionsWithScores(db: ReadonlyDb): Promise<MissionWithScore[]> {
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
    .where(eq(missions.status, "open"));

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
