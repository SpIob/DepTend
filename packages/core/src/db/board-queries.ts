/**
 * Paginated mission board queries (ADR 0031)
 *
 * This module owns the board-wide /missions listing: server-side filtering,
 * ordering, pagination, and per-axis facet counts. It also owns the per-repo
 * variant getRepoBoardPage() (ADR 0041) which uses the same payload shape
 * but constrains to one repo.
 *
 * Lives in packages/core (not /app) for the same reason as queries.ts:
 * keeps every Drizzle query against schema.ts in one program/project context,
 * avoiding the cross-package type-identity issue from ADR 0012.
 *
 * Ordering parity note: "priority" here is the same ranking key sequence as
 * scorer/ranking.ts's rankMissions() (tier bucket -> effort -> published_at ->
 * unique id), just evaluated by Postgres instead of Array#sort so LIMIT/
 * OFFSET can page through it. ADR 0017 (bucketing) and ADR 0018 (published_at
 * + osv_id tie-breaks) define the keys — nothing about them changed here.
 * One deliberate nuance: the absolute final fallback uses Postgres' default
 * collation rather than localeCompare, which only matters when two advisories
 * share tier, effort, AND exact published_at — the requirement is a stable,
 * deterministic order across pages, which both provide.
 */

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  advisories,
  dependencies,
  ecosystemEnum,
  effortLabelEnum,
  missions,
  missionScores,
  missionTypeEnum,
  repos,
  severityEnum,
} from "./schema.js";
import type { Ecosystem, EffortLabel, MissionType, Severity } from "./schema.js";
import { missionJoinRows, toMissionWithScore, type ReadonlyDb } from "./queries.js";
import type { BoardFacets, BoardFilters, BoardPage } from "./query-types.js";

// ---------------------------------------------------------------------------
// Board SQL fragments (mirror ranking.ts exactly — divergence is a silent bug)
// ---------------------------------------------------------------------------

/** SQL mirror of the per-row severity derivation: advisory severity or "unknown". */
export const BOARD_SEVERITY_EXPR = sql<string>`COALESCE(${advisories.severity}::text, 'unknown')`;

/** SQL mirror of the per-row ecosystem derivation: dependency's ecosystem, falling back to advisory's, else NULL. */
export const BOARD_ECOSYSTEM_EXPR = sql<string>`COALESCE(${dependencies.ecosystem}::text, ${advisories.ecosystem}::text)`;

export const BOARD_EFFORT_EXPR = sql<string>`${missionScores.effortLabel}::text`;

export const BOARD_MISSION_TYPE_EXPR = sql<string>`${missions.missionType}::text`;

/** SQL mirror of ranking.ts's effortRank(). */
export const BOARD_EFFORT_RANK_EXPR = sql<number>`CASE ${missionScores.effortLabel} WHEN 'trivial' THEN 0 WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 END`;

/** SQL mirror of ranking.ts's compositeTier() (same 0.5-wide buckets).
 *  Indexable by idx_mission_scores_composite_tier (ADR 0045) so the planner
 *  can replace the full sort with an ordered index scan on the board's
 *  "priority" ORDER BY lead key. The expression MUST stay byte-identical to
 *  scorer/ranking.ts:compositeTier() — divergence is a silent ordering bug. */
export const BOARD_TIER_EXPR = sql<number>`FLOOR(${missionScores.compositeScore} / 0.5)`;

/** Newest known vulnerability first; NULL sorts last (ranking.ts's -Infinity). */
export const BOARD_PUBLISHED_DESC = sql`${advisories.publishedAt} DESC NULLS LAST`;

/** Absolute, always-present final fallback (ranking.ts's osv_id ?? mission id).
 * osv_id is text and mission id is uuid — Postgres refuses COALESCE across
 * them (42804, found live: this expression alone took down /missions in
 * production), so the id side casts to text. */
export const BOARD_UNIQUE_ASC = sql`COALESCE(${advisories.osvId}, ${missions.id}::text) ASC`;

/** Rows per page of the board-wide /missions listing. */
export const BOARD_PAGE_SIZE = 50;

export type BoardSortMode = "priority" | "quick-wins" | "newest" | "ecosystem" | "effort";

interface BoardConditionParts {
  /** Status scope — always applied. */
  status: SQL;
  q: SQL | undefined;
  severity: SQL | undefined;
  ecosystem: SQL | undefined;
  effort: SQL | undefined;
  missionType: SQL | undefined;
}

function boardInSet(expr: SQL, values: readonly string[]): SQL {
  return sql`${expr} IN (${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}

function ilikePattern(q: string): string {
  return `%${q.replace(/([\\%_])/g, "\\$1")}%`;
}

function buildBoardConditionParts(filters: BoardFilters): BoardConditionParts {
  const parts: BoardConditionParts = {
    status: inArray(missions.status, ["open", "claimed"]),
    q: undefined,
    severity: undefined,
    ecosystem: undefined,
    effort: undefined,
    missionType: undefined,
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
  if (filters.missionTypes.length > 0) {
    parts.missionType = boardInSet(BOARD_MISSION_TYPE_EXPR, filters.missionTypes);
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
    case "ecosystem":
      // Group by ecosystem, then by priority within each ecosystem
      return [
        sql`${BOARD_ECOSYSTEM_EXPR} ASC NULLS LAST`,
        sql`${BOARD_TIER_EXPR} DESC`,
        sql`${BOARD_EFFORT_RANK_EXPR} ASC`,
        BOARD_PUBLISHED_DESC,
        BOARD_UNIQUE_ASC,
      ];
    case "effort":
      // Group by effort level, then by priority within each effort
      return [
        sql`${BOARD_EFFORT_RANK_EXPR} ASC`,
        sql`${BOARD_TIER_EXPR} DESC`,
        BOARD_PUBLISHED_DESC,
        BOARD_UNIQUE_ASC,
      ];
  }
}

/** SQL fragment for a WHERE slot that may have no conditions — `and()`
 *  returns undefined when every input is undefined, which can't interpolate. */
function condSql(...conditions: (SQL | undefined)[]): SQL {
  return and(...conditions) ?? sql`true`;
}

/** Builds the per-axis facet count(*) FILTER (WHERE ...) expressions the
 *  tally statement projects (ADR 0031). The four axis loops are identical
 *  between getBoardMissionsWithScoresPage and getRepoBoardPage, so they're
 *  shared here. `repoScope` is the optional per-repo filter the per-repo
 *  page applies to the tally's outer WHERE. */
function buildBoardTallySelect(
  parts: BoardConditionParts,
  repoScope: SQL | undefined,
): Record<string, SQL<number>> {
  const tallySelect: Record<string, SQL<number>> = {
    total: sql`(count(*) filter (where ${condSql(
      parts.severity,
      parts.ecosystem,
      parts.effort,
      parts.missionType,
      repoScope,
    )}))::int`,
  };
  const axes: readonly {
    values:
      readonly Severity[] | readonly Ecosystem[] | readonly EffortLabel[] | readonly MissionType[];
    expr: SQL;
    prefix: "severity" | "ecosystem" | "effort" | "missionType";
  }[] = [
    { values: severityEnum.enumValues, expr: BOARD_SEVERITY_EXPR, prefix: "severity" },
    { values: ecosystemEnum.enumValues, expr: BOARD_ECOSYSTEM_EXPR, prefix: "ecosystem" },
    { values: effortLabelEnum.enumValues, expr: BOARD_EFFORT_EXPR, prefix: "effort" },
    { values: missionTypeEnum.enumValues, expr: BOARD_MISSION_TYPE_EXPR, prefix: "missionType" },
  ];

  for (const axis of axes) {
    const otherAxisParts: BoardConditionParts = {
      status: parts.status,
      q: parts.q,
      severity: axis.prefix === "severity" ? undefined : parts.severity,
      ecosystem: axis.prefix === "ecosystem" ? undefined : parts.ecosystem,
      effort: axis.prefix === "effort" ? undefined : parts.effort,
      missionType: axis.prefix === "missionType" ? undefined : parts.missionType,
    };
    for (const value of axis.values) {
      tallySelect[`${axis.prefix}_${value}`] =
        sql`(count(*) filter (where ${axis.expr} = ${value} and ${condSql(
          otherAxisParts.severity,
          otherAxisParts.ecosystem,
          otherAxisParts.effort,
          otherAxisParts.missionType,
          repoScope,
        )}))::int`;
    }
  }
  return tallySelect;
}

/** Runs the merged tally statement (total + per-axis facet counts) the
 *  board page returns alongside the row page. `repoScope` narrows the
 *  tally to one repo when set; pass undefined for the board-wide path. */
async function runBoardTally(
  db: ReadonlyDb,
  parts: BoardConditionParts,
  repoScope: SQL | undefined,
): Promise<{
  total: number;
  facets: BoardFacets;
}> {
  const [tallyRows] = await Promise.all([
    db
      .select(buildBoardTallySelect(parts, repoScope))
      .from(missions)
      .innerJoin(missionScores, eq(missionScores.missionId, missions.id))
      .innerJoin(repos, eq(missions.repoId, repos.id))
      .leftJoin(advisories, eq(missions.advisoryId, advisories.id))
      .leftJoin(dependencies, eq(missions.dependencyId, dependencies.id))
      .where(and(parts.status, parts.q, repoScope)),
  ]);
  const tally = tallyRows[0];

  function tallyFacet<T extends string>(
    values: readonly T[],
    prefix: "severity" | "ecosystem" | "effort" | "missionType",
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
    total: tally?.total ?? 0,
    facets: {
      severity: tallyFacet<Severity>(severityEnum.enumValues, "severity"),
      ecosystem: tallyFacet<Ecosystem>(ecosystemEnum.enumValues, "ecosystem"),
      effort: tallyFacet<EffortLabel>(effortLabelEnum.enumValues, "effort"),
      missionType: tallyFacet<MissionType>(missionTypeEnum.enumValues, "missionType"),
    },
  };
}

/**
 * Shared body of getBoardMissionsWithScoresPage and getRepoBoardPage:
 * run the row query and the tally query in parallel, then assemble the
 * BoardPage. The two public functions differ only in whether a `repoScope`
 * is included in the row query's WHERE (and passed to the tally); this
 * helper takes that scope as a single optional argument so the two
 * callers stay one-liners.
 */
async function fetchBoardPage(
  db: ReadonlyDb,
  parts: BoardConditionParts,
  filters: BoardFilters,
  options: { limit: number; offset: number; repoScope?: SQL },
): Promise<BoardPage> {
  const whereParts = [
    parts.status,
    parts.q,
    parts.severity,
    parts.ecosystem,
    parts.effort,
    parts.missionType,
    ...(options.repoScope !== undefined ? [options.repoScope] : []),
  ];

  const [rows, { total, facets }] = await Promise.all([
    missionJoinRows(db)
      .where(and(...whereParts))
      .orderBy(...boardOrderBy(filters.sort))
      .limit(options.limit)
      .offset(options.offset),
    runBoardTally(db, parts, options.repoScope),
  ]);

  return {
    missions: rows.map(toMissionWithScore),
    total,
    facets,
  };
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
  return fetchBoardPage(db, parts, filters, { limit, offset });
}

/**
 * Per-repo version of getBoardMissionsWithScoresPage (ADR 0041) — same
 * payload shape and same filter/sort/facet semantics, but constrained to
 * one repo so the per-repo page can hand it to the same
 * PaginatedMissionBoard component the board-wide /missions listing uses
 * (the page passes pageSize=missions.length and pageCount=1 to suppress
 * pagination). Kept as a sibling of getBoardMissionsWithScoresPage rather
 * than a repoId field on BoardFilters so the public filter type stays
 * about board scope, not single-repo shortcuts.
 *
 * `options.limit` defaults to BOARD_PAGE_SIZE (50) so an unpaged caller
 * still gets a server-side LIMIT — the board-wide list never asks for
 * everything. The per-repo page passes its own limit (see app/src/app/repo/
 * [owner]/[name]/page.tsx) because it suppresses pagination and would
 * otherwise silently drop a single repo's missions past 50.
 */
export async function getRepoBoardPage(
  db: ReadonlyDb,
  repoId: string,
  filters: BoardFilters,
  options: { limit?: number; offset?: number } = {},
): Promise<BoardPage> {
  const limit = Math.max(1, options.limit ?? BOARD_PAGE_SIZE);
  const offset = Math.max(0, options.offset ?? 0);
  const parts = buildBoardConditionParts(filters);
  return fetchBoardPage(db, parts, filters, {
    limit,
    offset,
    repoScope: eq(missions.repoId, repoId),
  });
}
