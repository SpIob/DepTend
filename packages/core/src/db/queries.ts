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

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema.js";
import {
  advisories,
  dependencies,
  ecosystemEnum,
  effortLabelEnum,
  missions,
  missionScores,
  repos,
  severityEnum,
} from "./schema.js";
import type { Ecosystem, EffortLabel, MissionStatus, Severity } from "./schema.js";
import { rankMissions, type RankableMission } from "../scorer/ranking.js";
import {
  EMPTY_REPO_MISSION_COUNTS,
  type AdvisorySummary,
  type MissionWithScore,
  type RepoMissionCounts,
  type RepoWithMissionSummary,
} from "./query-types.js";
import { getBookmarkedRepoIds } from "./bookmarks.js";

export type ReadonlyDb = NeonHttpDatabase<typeof schema>;

/**
 * Advisory columns the list rows actually ship (see AdvisorySummary in
 * query-types.ts for what's left out and why). The key order here is the
 * SELECT-list order the driver maps positional rows against — queries.test.ts's
 * joinedRow() fixture must match it.
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
 * The five-table join behind every mission-listing read here: missions with
 * score, advisory, dependency, and owning repo attached. Shared by
 * getMissionsWithScoresByStatus() (fetch-everything-then-rank-in-JS) and
 * getBoardMissionsWithScoresPage() (SQL-side filter/order/paginate) so the
 * two paths can't drift apart.
 *
 * The return type is Drizzle's chained query builder, whose branded generics
 * are not practically writable by hand — same family of typed-linting
 * friction ADR 0012 documents for cross-tsconfig checking. The inferred
 * type is still fully checked at every call site.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function missionJoinRows(db: ReadonlyDb) {
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

function toMissionWithScore(row: MissionJoinRow): MissionWithScore {
  // A left-joined partial selection types every field as nullable, but at
  // runtime the row is either a full advisory (id present ⇒ the join hit a
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
 * getBoardMissionsWithScoresPage (ADR 0031) — SQL-side filtering/sorting/
 * pagination — and nothing else ever consumed the fetch-everything shape.
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

// ---------------------------------------------------------------------------
// Paginated mission board (ADR 0031)
//
// The board-wide /missions listing used to fetch every open+claimed mission
// and filter/search/sort/rank it in the browser (the functions above). That
// made the DB query, the HTTP payload, and the client's working set all grow
// linearly with total missions — the "unbounded DB query" known issue. This
// section moves filtering, ordering, and pagination into SQL for that one
// page; the per-repo page keeps the fetch-everything path above, where cost
// is already bounded by a single repo.
//
// Ordering parity note: "priority" here is the same ranking key sequence as
// scorer/ranking.ts's rankMissions() (tier bucket → effort → published_at →
// unique id), just evaluated by Postgres instead of Array#sort so LIMIT/
// OFFSET can page through it. ADR 0017 (bucketing) and ADR 0018 (published_at
// + osv_id tie-breaks) define the keys — nothing about them changed here.
// One deliberate nuance: the absolute final fallback uses Postgres' default
// collation rather than localeCompare, which only matters when two advisories
// share tier, effort, AND exact published_at — the requirement is a stable,
// deterministic order across pages, which both provide.
// ---------------------------------------------------------------------------

/** Rows per page of the board-wide /missions listing. */
export const BOARD_PAGE_SIZE = 50;

export type BoardSortMode = "priority" | "quick-wins" | "newest";

export interface BoardFilters {
  /** Substring matched against title, package name, owner/name, and OSV id. */
  q: string;
  severities: readonly Severity[];
  ecosystems: readonly Ecosystem[];
  efforts: readonly EffortLabel[];
  sort: BoardSortMode;
}

/**
 * Per-axis result counts for the filter chips. Each axis counts rows
 * matching every *other* active axis (plus q) but not itself — same
 * semantics the client-side board computed, so a chip still answers
 * "how many results if I also picked this."
 */
export interface BoardFacets {
  severity: Partial<Record<Severity, number>>;
  ecosystem: Partial<Record<Ecosystem, number>>;
  effort: Partial<Record<EffortLabel, number>>;
}

export interface BoardPage {
  missions: MissionWithScore[];
  /** Total open+claimed missions matching all filters (not just this page). */
  total: number;
  facets: BoardFacets;
}

/** SQL mirror of mission-board.tsx's severityOf(): advisory severity or "unknown". */
const BOARD_SEVERITY_EXPR = sql<string>`COALESCE(${advisories.severity}::text, 'unknown')`;

/**
 * SQL mirror of mission-board.tsx's ecosystemOf(): dependency's ecosystem,
 * falling back to the advisory's, else NULL (a row with neither never
 * matches a non-empty ecosystem filter — IN() excludes NULLs, matching the
 * client's matchesSet()).
 */
const BOARD_ECOSYSTEM_EXPR = sql<string>`COALESCE(${dependencies.ecosystem}::text, ${advisories.ecosystem}::text)`;

const BOARD_EFFORT_EXPR = sql<string>`${missionScores.effortLabel}::text`;

/** SQL mirror of ranking.ts's effortRank(). */
const BOARD_EFFORT_RANK_EXPR = sql<number>`CASE ${missionScores.effortLabel} WHEN 'trivial' THEN 0 WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 END`;

/** SQL mirror of ranking.ts's compositeTier() (same 0.5-wide buckets). */
const BOARD_TIER_EXPR = sql<number>`FLOOR(${missionScores.compositeScore} / 0.5)`;

/** Newest known vulnerability first; NULL sorts last (ranking.ts's -Infinity). */
const BOARD_PUBLISHED_DESC = sql`${advisories.publishedAt} DESC NULLS LAST`;

/** Absolute, always-present final fallback (ranking.ts's osv_id ?? mission id).
 * osv_id is text and mission id is uuid — Postgres refuses COALESCE across
 * them (42804, found live: this expression alone took down /missions in
 * production), so the id side casts to text. */
const BOARD_UNIQUE_ASC = sql`COALESCE(${advisories.osvId}, ${missions.id}::text) ASC`;

function boardInSet(expr: SQL, values: readonly string[]): SQL {
  return sql`${expr} IN (${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}

/**
 * LIKE-pattern escape so a search for e.g. "100%" matches the literal
 * string, mirroring the client's String.includes() semantics.
 */
function ilikePattern(q: string): string {
  return `%${q.replace(/([\\%_])/g, "\\$1")}%`;
}

interface BoardConditionParts {
  /** Status scope — always applied. */
  status: SQL;
  q: SQL | undefined;
  severity: SQL | undefined;
  ecosystem: SQL | undefined;
  effort: SQL | undefined;
}

function buildBoardConditionParts(filters: BoardFilters): BoardConditionParts {
  const parts: BoardConditionParts = {
    status: inArray(missions.status, ["open", "claimed"]),
    q: undefined,
    severity: undefined,
    ecosystem: undefined,
    effort: undefined,
  };

  const q = filters.q.trim();
  if (q !== "") {
    const pattern = ilikePattern(q);
    parts.q = sql`(
      COALESCE(${missions.title}, '') ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(${dependencies.packageName}, '') ILIKE ${pattern} ESCAPE '\\'
      OR (${repos.owner} || '/' || ${repos.name}) ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(${advisories.osvId}, '') ILIKE ${pattern} ESCAPE '\\'
    )`;
  }

  if (filters.severities.length > 0) {
    parts.severity = boardInSet(BOARD_SEVERITY_EXPR, filters.severities);
  }
  if (filters.ecosystems.length > 0) {
    parts.ecosystem = boardInSet(BOARD_ECOSYSTEM_EXPR, filters.ecosystems);
  }
  if (filters.efforts.length > 0) {
    parts.effort = boardInSet(BOARD_EFFORT_EXPR, filters.efforts);
  }

  return parts;
}

function boardOrderBy(sort: BoardSortMode): SQL[] {
  switch (sort) {
    case "priority":
      // rankMissions()' exact key sequence, evaluated by Postgres.
      return [
        sql`${BOARD_TIER_EXPR} DESC`,
        sql`${BOARD_EFFORT_RANK_EXPR} ASC`,
        BOARD_PUBLISHED_DESC,
        BOARD_UNIQUE_ASC,
      ];
    case "quick-wins":
      return [
        sql`${BOARD_EFFORT_RANK_EXPR} ASC`,
        sql`${missionScores.compositeScore} DESC`,
        BOARD_UNIQUE_ASC,
      ];
    case "newest":
      return [BOARD_PUBLISHED_DESC, BOARD_UNIQUE_ASC];
  }
}

/** SQL fragment for a WHERE slot that may have no conditions — `and()`
 * returns undefined when every input is undefined, which can't interpolate. */
function condSql(...conditions: (SQL | undefined)[]): SQL {
  return and(...conditions) ?? sql`true`;
}

/**
 * One page of the board-wide /missions listing (ADR 0031): open+claimed
 * missions matching the given filters, ordered server-side, plus the
 * unpaginated total and per-axis facet counts the filter UI needs.
 *
 * The total and all three facets come out of ONE statement — a single join
 * scan with count(*) FILTER (WHERE ...) columns — where ADR 0031's original
 * implementation fanned out four (one count + three GROUP BYs). Safe to
 * merge because severity/ecosystem/effort are closed enums: every facet
 * bucket is a known column, so no dynamic GROUP BY is needed, and a FILTER
 * comparison against a NULL ecosystem just excludes the row, matching the
 * GROUP-BY-then-skip-null-keys behavior it replaced.
 *
 * Filter placement matters: the statement's outer WHERE stays at status+q,
 * and each FILTER carries its own axis combination — every facet ignores
 * its own axis's filter ("how many if I also picked this") while the total
 * applies all of them. That keeps each aggregate counting from an
 * appropriately-scoped row set without re-running the join per axis.
 */
export async function getBoardMissionsWithScoresPage(
  db: ReadonlyDb,
  filters: BoardFilters,
  options: { limit?: number; offset?: number } = {},
): Promise<BoardPage> {
  const limit = Math.max(1, options.limit ?? BOARD_PAGE_SIZE);
  const offset = Math.max(0, options.offset ?? 0);
  const parts = buildBoardConditionParts(filters);

  const tallySelect: Record<string, SQL<number>> = {
    total: sql`(count(*) filter (where ${condSql(parts.severity, parts.ecosystem, parts.effort)}))::int`,
  };
  // Column names are prefixed by axis because severity and effort share the
  // values "low"/"medium"/"high" — severity_low vs effort_low must not collide.
  for (const value of severityEnum.enumValues) {
    tallySelect[`severity_${value}`] =
      sql`(count(*) filter (where ${BOARD_SEVERITY_EXPR} = ${value} and ${condSql(parts.ecosystem, parts.effort)}))::int`;
  }
  for (const value of ecosystemEnum.enumValues) {
    tallySelect[`ecosystem_${value}`] =
      sql`(count(*) filter (where ${BOARD_ECOSYSTEM_EXPR} = ${value} and ${condSql(parts.severity, parts.effort)}))::int`;
  }
  for (const value of effortLabelEnum.enumValues) {
    tallySelect[`effort_${value}`] =
      sql`(count(*) filter (where ${BOARD_EFFORT_EXPR} = ${value} and ${condSql(parts.severity, parts.ecosystem)}))::int`;
  }

  const [rows, tallyRows] = await Promise.all([
    missionJoinRows(db)
      .where(and(parts.status, parts.q, parts.severity, parts.ecosystem, parts.effort))
      .orderBy(...boardOrderBy(filters.sort))
      .limit(limit)
      .offset(offset),
    db
      .select(tallySelect)
      .from(missions)
      .innerJoin(missionScores, eq(missionScores.missionId, missions.id))
      .innerJoin(repos, eq(missions.repoId, repos.id))
      .leftJoin(advisories, eq(missions.advisoryId, advisories.id))
      .leftJoin(dependencies, eq(missions.dependencyId, dependencies.id))
      .where(and(parts.status, parts.q)),
  ]);

  const tally = tallyRows[0];

  function tallyFacet<T extends string>(
    values: readonly T[],
    prefix: "severity" | "ecosystem" | "effort",
  ): Partial<Record<T, number>> {
    const out: Partial<Record<T, number>> = {};
    for (const value of values) {
      const count = tally?.[`${prefix}_${value}`] ?? 0;
      if (count > 0) {
        out[value] = count;
      }
    }
    return out;
  }

  return {
    missions: rows.map(toMissionWithScore),
    total: tally?.total ?? 0,
    facets: {
      severity: tallyFacet<Severity>(severityEnum.enumValues, "severity"),
      ecosystem: tallyFacet<Ecosystem>(ecosystemEnum.enumValues, "ecosystem"),
      effort: tallyFacet<EffortLabel>(effortLabelEnum.enumValues, "effort"),
    },
  };
}

/** Count of repos that have completed at least one ingestion run. */
export async function getIndexedRepoCount(db: ReadonlyDb): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(repos)
    .where(eq(repos.ingestionStatus, "complete"));
  return rows[0]?.count ?? 0;
}

/**
 * Count of all submitted repos, regardless of ingestion status. This is
 * what the MVP repo cap actually limits — matches the count submitRepo()
 * checks server-side (packages/core/src/db/repos.ts). Distinct from
 * getIndexedRepoCount() above, which is the public-facing "successfully
 * processed" stat, not the submission cap.
 */
export async function getTotalRepoCount(db: ReadonlyDb): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(repos);
  return rows[0]?.count ?? 0;
}

export interface SkippedRepo {
  owner: string;
  name: string;
  /** Why the winning ingestor couldn't find/parse a manifest — see writer.ts. */
  reason: string | null;
}

/**
 * Repos whose most recent ingestion completed without error but found no
 * analyzable package.json/pyproject.toml/requirements.txt/go.mod (status:
 * "skipped" — see the ingestion_status enum's own comment in schema.ts).
 * Still counts against the repo cap via getTotalRepoCount() above; excluded
 * from getIndexedRepoCount() since nothing was actually indexed. Small
 * enough a list that the dashboard can show it in full — no pagination.
 */
export async function getSkippedRepos(db: ReadonlyDb): Promise<SkippedRepo[]> {
  return db
    .select({ owner: repos.owner, name: repos.name, reason: repos.ingestionError })
    .from(repos)
    .where(eq(repos.ingestionStatus, "skipped"));
}

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

/**
 * One row per repo for the directory page (ADR 0027) — mission counts by
 * severity and the set of ecosystems present, without shipping every
 * mission's full payload the way the fetch-everything queries above do.
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
 * isBookmarked is false on every row. This is the login-independent base
 * /app caches under its "repos" tag (ADR 0033); getReposWithMissionSummary()
 * overlays the viewer's bookmarks on top of it, uncached.
 */
export async function getRepoDirectoryBase(db: ReadonlyDb): Promise<RepoWithMissionSummary[]> {
  const [repoRows, ecosystemRows, severityRows] = await Promise.all([
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
    isBookmarked: false,
  }));
}

/**
 * getRepoDirectoryBase() plus the viewer's bookmark flags. userLogin is
 * optional — omit it (e.g. a signed-out visitor) and every row's
 * isBookmarked is simply false, not a separate tri-state.
 */
export async function getReposWithMissionSummary(
  db: ReadonlyDb,
  userLogin?: string,
): Promise<RepoWithMissionSummary[]> {
  const repos = await getRepoDirectoryBase(db);
  if (userLogin === undefined) {
    return repos;
  }
  const bookmarkedRepoIds = await getBookmarkedRepoIds(db, userLogin);
  return repos.map((repo) =>
    bookmarkedRepoIds.has(repo.id) ? { ...repo, isBookmarked: true } : repo,
  );
}
