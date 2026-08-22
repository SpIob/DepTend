/**
 * queries.ts unit tests
 *
 * Strategy: real Drizzle query building, fake transport. drizzle() accepts
 * any callable client (neon-http's driver just invokes it as
 * `client(sql, params, config)` and reads `.rows` off the result), so the
 * tests hand queries.ts a genuine NeonHttpDatabase wired to a vi.fn that
 * records every statement and routes back canned positional-array rows —
 * exactly what the real driver returns under arrayMode. That means the
 * assertions below see the actual SQL text (quoting, casing, expression
 * order) Drizzle will send to Postgres, with no database and no network.
 *
 * The load-bearing invariant this file guards is the ADR 0031 ordering-
 * parity contract: boardOrderBy()'s SQL key sequence must mirror
 * scorer/ranking.ts's rankMissions() (tier bucket → effort rank →
 * published_at DESC NULLS LAST → unique id). The JS side of that contract
 * is owned by ranking.test.ts — when a ranking key changes, both suites
 * must move together (AGENTS.md §2).
 */

import { describe, expect, it, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import type { PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";
import {
  BOARD_PAGE_SIZE,
  getBoardMissionsWithScoresPage,
  getIndexedRepoCount,
  getOpenMissionsWithScores,
  getRepoEcosystems,
  getRepoMissionsWithScores,
  getReposWithMissionSummary,
  getSkippedRepos,
  getTotalRepoCount,
  type BoardFilters,
  type ReadonlyDb,
} from "./queries.js";
import { advisories, dependencies, missions, missionScores, repos } from "./schema.js";

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

interface CapturedCall {
  sql: string;
  params: unknown[];
}

/** Routes one captured statement to canned rows, keyed by query shape. */
type RowRouter = (sql: string) => unknown[][];

function makeDb(route: RowRouter): { db: ReadonlyDb; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const client = vi.fn((text: string, params: unknown[]): Promise<{ rows: unknown[][] }> => {
    calls.push({ sql: text, params });
    return Promise.resolve({ rows: route(text) });
  });
  // drizzle() accepts any callable client (see driver.js's construct());
  // the casts only bridge the neon types it would otherwise infer.
  const db = drizzle(client as never, { schema }) as unknown as ReadonlyDb;
  return { db, calls };
}

/** Expands a fixture object (TS property names) into driver-shape positional row order. */
function flatten(table: PgTable, values: Record<string, unknown>): unknown[] {
  return Object.entries(getTableColumns(table)).map(([key]) => values[key] ?? null);
}

function bySql(calls: readonly CapturedCall[], pattern: RegExp): CapturedCall {
  const match = calls.find((call) => pattern.test(call.sql));
  if (match === undefined) {
    throw new Error(
      `No captured call matched ${String(pattern)} in:\n${calls.map((c) => c.sql).join("\n---\n")}`,
    );
  }
  return match;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-01T00:00:00.000Z");

const MISSION_VALUES: Record<string, unknown> = {
  id: "m-1",
  repoId: "r-1",
  title: "Update lodash to fix a high vulnerability",
  description: "description",
  actionHint: null,
  missionType: "vulnerability_fix",
  status: "open",
  advisoryId: "a-1",
  dependencyId: "d-1",
  claimedBy: null,
  claimedAt: null,
  resolvedAt: null,
  dismissedAt: null,
  dismissReason: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const SCORE_VALUES: Record<string, unknown> = {
  id: "s-1",
  missionId: "m-1",
  impactScore: 7.5,
  ecosystemValueScore: 5,
  compositeScore: 6.5,
  effortLabel: "low",
  impactInputs: {},
  ecosystemValueInputs: {},
  effortInputs: {},
  confidence: "low",
  confidenceNotes: null,
  confidenceFlags: {},
  scoringVersion: "0.1.0",
  createdAt: NOW,
  updatedAt: NOW,
};

const ADVISORY_VALUES: Record<string, unknown> = {
  id: "a-1",
  osvId: "GHSA-xxxx-yyyy-zzzz",
  source: "osv",
  ecosystem: "npm",
  packageName: "lodash",
  severity: "high",
  cvssScore: 7.5,
  summary: "summary",
  details: null,
  affectedVersions: [],
  fixedVersion: "4.17.21",
  publishedAt: NOW,
  modifiedAt: NOW,
  rawData: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const DEPENDENCY_VALUES: Record<string, unknown> = {
  id: "d-1",
  repoId: "r-1",
  ecosystem: "npm",
  packageName: "lodash",
  versionSpec: "^4.17.20",
  resolvedVersion: null,
  depType: "production",
  latestVersion: null,
  isDeprecated: false,
  deprecationNote: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const REPO_VALUES: Record<string, unknown> = {
  id: "r-1",
  githubUrl: "https://github.com/octo/repo",
  owner: "octo",
  name: "repo",
  defaultBranch: "main",
  description: null,
  stars: 10,
  openIssuesCount: 2,
  topics: [],
  homepageUrl: null,
  ingestionStatus: "complete",
  lastIngestedAt: NOW,
  ingestionError: null,
  submittedBy: null,
  createdAt: NOW,
  updatedAt: NOW,
};

/** One fully-populated five-table join row, in driver positional order. */
function joinedRow(): unknown[] {
  return [
    ...flatten(missions, MISSION_VALUES),
    ...flatten(missionScores, SCORE_VALUES),
    ...flatten(advisories, ADVISORY_VALUES),
    ...flatten(dependencies, DEPENDENCY_VALUES),
    ...flatten(repos, REPO_VALUES),
  ];
}

const EMPTY_FILTERS: BoardFilters = {
  q: "",
  severities: [],
  ecosystems: [],
  efforts: [],
  sort: "priority",
};

/** Default routing for the board query's five parallel statements. */
function boardRouter(
  overrides: Partial<Record<"page" | "total" | "sev" | "eco" | "effort", unknown[][]>>,
): RowRouter {
  return (sql: string): unknown[][] => {
    if (sql.includes("limit ")) return overrides.page ?? [joinedRow()];
    if (/group by/i.test(sql)) {
      const selectList = sql.slice(sql.indexOf("select"), sql.indexOf(" from "));
      if (/coalesce\("advisories"\."severity"/i.test(selectList)) return overrides.sev ?? [];
      if (/coalesce\("dependencies"\."ecosystem"/i.test(selectList)) return overrides.eco ?? [];
      return overrides.effort ?? [];
    }
    return overrides.total ?? [[3]];
  };
}

// ---------------------------------------------------------------------------
// Ordering parity (ADR 0031 ↔ ADR 0017/0018)
// ---------------------------------------------------------------------------

describe("getBoardMissionsWithScoresPage ordering parity", () => {
  it("priority sort emits rankMissions()' exact key sequence in SQL", async () => {
    const { db, calls } = makeDb(boardRouter({}));
    await getBoardMissionsWithScoresPage(db, { ...EMPTY_FILTERS, sort: "priority" });

    const sql = bySql(calls, /limit /).sql;
    const tier = sql.indexOf('FLOOR("mission_scores"."composite_score" / 0.5) DESC');
    const effort = sql.indexOf(
      `CASE "mission_scores"."effort_label" WHEN 'trivial' THEN 0 WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 END ASC`,
    );
    const published = sql.indexOf('"advisories"."published_at" DESC NULLS LAST');
    const unique = sql.indexOf('COALESCE("advisories"."osv_id", "missions"."id") ASC');

    expect(tier).toBeGreaterThan(-1);
    expect(effort).toBeGreaterThan(tier);
    expect(published).toBeGreaterThan(effort);
    expect(unique).toBeGreaterThan(published);
  });

  it("quick-wins sort puts effort first, then raw composite score, then the unique fallback", async () => {
    const { db, calls } = makeDb(boardRouter({}));
    await getBoardMissionsWithScoresPage(db, { ...EMPTY_FILTERS, sort: "quick-wins" });

    const sql = bySql(calls, /limit /).sql;
    const effort = sql.indexOf(
      `CASE "mission_scores"."effort_label" WHEN 'trivial' THEN 0 WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 END ASC`,
    );
    const composite = sql.indexOf('"mission_scores"."composite_score" DESC');
    const unique = sql.indexOf('COALESCE("advisories"."osv_id", "missions"."id") ASC');

    expect(effort).toBeGreaterThan(-1);
    expect(composite).toBeGreaterThan(effort);
    expect(unique).toBeGreaterThan(composite);
    expect(sql).not.toContain("FLOOR(");
  });

  it("newest sort is published_at DESC NULLS LAST then the unique fallback", async () => {
    const { db, calls } = makeDb(boardRouter({}));
    await getBoardMissionsWithScoresPage(db, { ...EMPTY_FILTERS, sort: "newest" });

    const sql = bySql(calls, /limit /).sql;
    const published = sql.indexOf('"advisories"."published_at" DESC NULLS LAST');
    const unique = sql.indexOf('COALESCE("advisories"."osv_id", "missions"."id") ASC');

    expect(published).toBeGreaterThan(-1);
    expect(unique).toBeGreaterThan(published);
    expect(sql).not.toContain("FLOOR(");
    expect(sql).not.toContain('CASE "mission_scores"');
  });
});

// ---------------------------------------------------------------------------
// Filters, pagination, and result shaping
// ---------------------------------------------------------------------------

describe("getBoardMissionsWithScoresPage filters", () => {
  it("always scopes to open+claimed and adds no filter params for empty filters", async () => {
    const { db, calls } = makeDb(boardRouter({}));
    await getBoardMissionsWithScoresPage(db, EMPTY_FILTERS);

    const page = bySql(calls, /limit /);
    expect(page.params).toContain("open");
    expect(page.params).toContain("claimed");
    expect(page.params.join("\u0000")).not.toMatch(/%/);
  });

  it("binds an escaped ILIKE pattern for q across title, package, owner/name, and osv id", async () => {
    const { db, calls } = makeDb(boardRouter({}));
    await getBoardMissionsWithScoresPage(db, { ...EMPTY_FILTERS, q: "100%_x\\" });

    const page = bySql(calls, /limit /);
    expect(page.sql).toContain("ILIKE");
    expect(page.sql).toContain("ESCAPE '\\'");
    expect(page.params).toContain(`%100\\%\\_x\\\\%`);
  });

  it("binds set filters and keeps each facet's own axis out of that facet's WHERE", async () => {
    const filters: BoardFilters = {
      q: "lodash",
      severities: ["high", "critical"],
      ecosystems: ["npm"],
      efforts: ["trivial"],
      sort: "priority",
    };
    const { db, calls } = makeDb(boardRouter({}));
    await getBoardMissionsWithScoresPage(db, filters);

    const page = bySql(calls, /limit /);
    for (const value of [
      ...filters.severities,
      ...filters.ecosystems,
      ...filters.efforts,
      "%lodash%",
    ]) {
      expect(page.params).toContain(value);
    }

    const groupCalls = calls.filter((call) => /group by/i.test(call.sql));
    expect(groupCalls).toHaveLength(3);

    const facetFor = (axis: RegExp): CapturedCall => {
      const match = groupCalls.find((call) =>
        axis.test(call.sql.slice(call.sql.indexOf("select"), call.sql.indexOf(" from "))),
      );
      if (match === undefined) {
        throw new Error(`No facet call matched ${String(axis)}`);
      }
      return match;
    };

    const sev = facetFor(/coalesce\("advisories"\."severity"/i);
    const eco = facetFor(/coalesce\("dependencies"\."ecosystem"/i);
    const effort = facetFor(/"mission_scores"\."effort_label"/i);

    // Severity facet counts rows matching every OTHER axis — its params must
    // not bind the severity set, but must bind q, ecosystems, and efforts.
    expect(sev.params).not.toContain("high");
    expect(sev.params).not.toContain("critical");
    expect(sev.params).toContain("%lodash%");
    expect(sev.params).toContain("npm");
    expect(sev.params).toContain("trivial");

    expect(eco.params).not.toContain("npm");
    expect(eco.params).toContain("high");
    expect(eco.params).toContain("%lodash%");

    expect(effort.params).not.toContain("trivial");
    expect(effort.params).toContain("high");
    expect(effort.params).toContain("npm");
  });
});

describe("getBoardMissionsWithScoresPage pagination", () => {
  it("binds the default BOARD_PAGE_SIZE limit last and omits the zero offset", async () => {
    const { db, calls } = makeDb(boardRouter({}));
    await getBoardMissionsWithScoresPage(db, EMPTY_FILTERS);

    const page = bySql(calls, /limit /);
    expect(page.params.at(-1)).toBe(BOARD_PAGE_SIZE);
    expect(page.sql).not.toMatch(/offset /i);
  });

  it("binds explicit limit/offset values last", async () => {
    const { db, calls } = makeDb(boardRouter({}));
    await getBoardMissionsWithScoresPage(db, EMPTY_FILTERS, { limit: 7, offset: 14 });

    const params = bySql(calls, /limit /).params;
    expect(params.slice(-2)).toEqual([7, 14]);
  });

  it("clamps limit to >=1 and offset to >=0", async () => {
    const { db, calls } = makeDb(boardRouter({}));
    await getBoardMissionsWithScoresPage(db, EMPTY_FILTERS, { limit: 0, offset: -5 });

    const page = bySql(calls, /limit /);
    expect(page.params.at(-1)).toBe(1);
    // An offset clamped to 0 is omitted from the statement entirely.
    expect(page.sql).not.toMatch(/offset /i);
  });
});

describe("getBoardMissionsWithScoresPage result shaping", () => {
  it("maps the join row into MissionWithScore and tallies facets, skipping null keys", async () => {
    const { db } = makeDb(
      boardRouter({
        total: [[3]],
        sev: [
          ["high", 2],
          [null, 9],
          ["low", 1],
        ],
        eco: [["npm", 3]],
        effort: [["low", 3]],
      }),
    );
    const result = await getBoardMissionsWithScoresPage(db, EMPTY_FILTERS);

    expect(result.total).toBe(3);
    expect(result.missions).toEqual([
      {
        ...MISSION_VALUES,
        score: SCORE_VALUES,
        advisory: ADVISORY_VALUES,
        dependency: DEPENDENCY_VALUES,
        repo: REPO_VALUES,
      },
    ]);
    expect(result.facets.severity).toEqual({ high: 2, low: 1 });
    expect(result.facets.ecosystem).toEqual({ npm: 3 });
    expect(result.facets.effort).toEqual({ low: 3 });
  });

  it("returns zero total and empty facets when the board has no matching rows", async () => {
    const { db } = makeDb(boardRouter({ page: [], total: [] }));
    const result = await getBoardMissionsWithScoresPage(db, EMPTY_FILTERS);

    expect(result.total).toBe(0);
    expect(result.missions).toEqual([]);
    expect(result.facets).toEqual({ severity: {}, ecosystem: {}, effort: {} });
  });
});

// ---------------------------------------------------------------------------
// Fetch-everything path (per-repo board + JS-side ranking)
// ---------------------------------------------------------------------------

describe("getOpenMissionsWithScores / getRepoMissionsWithScores", () => {
  function twoRowRouter(): RowRouter {
    return (sql: string): unknown[][] => {
      if (/limit |group by/i.test(sql)) return [];
      const first = joinedRow();
      const second = [
        ...flatten(missions, { ...MISSION_VALUES, id: "m-2" }),
        ...flatten(missionScores, {
          ...SCORE_VALUES,
          id: "s-2",
          missionId: "m-2",
          compositeScore: 9.9,
          effortLabel: "high",
        }),
        ...flatten(advisories, ADVISORY_VALUES),
        ...flatten(dependencies, DEPENDENCY_VALUES),
        ...flatten(repos, REPO_VALUES),
      ];
      return [first, second];
    };
  }

  it("ranks rows through rankMissions() (higher composite first despite input order)", async () => {
    const { db } = makeDb(twoRowRouter());
    const result = await getOpenMissionsWithScores(db);

    expect(result.map((m) => m.id)).toEqual(["m-2", "m-1"]);
  });

  it("scopes to one repo when repoId is passed and binds the status set", async () => {
    const { db, calls } = makeDb(twoRowRouter());
    await getRepoMissionsWithScores(db, "r-1");

    const call = bySql(calls, /"missions"\."repo_id"/);
    expect(call.params).toContain("r-1");
    expect(call.params).toContain("open");
    expect(call.params).toContain("claimed");
  });
});

// ---------------------------------------------------------------------------
// Small count/list helpers
// ---------------------------------------------------------------------------

describe("getIndexedRepoCount / getTotalRepoCount", () => {
  it("counts only complete repos", async () => {
    const { db, calls } = makeDb(() => [[7]]);
    expect(await getIndexedRepoCount(db)).toBe(7);
    expect(bySql(calls, /from "repos"/).params).toContain("complete");
  });

  it("counts every submitted repo with no status filter", async () => {
    const { db, calls } = makeDb(() => [[2]]);
    expect(await getTotalRepoCount(db)).toBe(2);
    expect(calls[0]?.sql.toLowerCase()).not.toContain("where");
  });

  it("returns zero when the count row is missing", async () => {
    const { db } = makeDb(() => []);
    expect(await getIndexedRepoCount(db)).toBe(0);
  });
});

describe("getSkippedRepos", () => {
  it("maps owner/name/reason positionally, preserving null reasons", async () => {
    const { db } = makeDb(() => [
      ["octo", "no-manifest", "No package.json found"],
      ["octo", "empty", null],
    ]);
    expect(await getSkippedRepos(db)).toEqual([
      { owner: "octo", name: "no-manifest", reason: "No package.json found" },
      { owner: "octo", name: "empty", reason: null },
    ]);
  });
});

describe("getRepoEcosystems", () => {
  it("returns the distinct ecosystems as stored", async () => {
    const { db } = makeDb(() => [["npm"], ["go"]]);
    expect(await getRepoEcosystems(db, "r-1")).toEqual(["npm", "go"]);
  });
});

describe("getReposWithMissionSummary", () => {
  const REPO_2: Record<string, unknown> = { ...REPO_VALUES, id: "r-2", name: "other" };

  function summaryRouter(bookmarks: unknown[][]): RowRouter {
    return (sql: string): unknown[][] => {
      if (sql.includes("repo_bookmarks")) return bookmarks;
      if (/select distinct/i.test(sql))
        return [
          ["r-1", "npm"],
          ["r-2", "go"],
        ];
      if (/group by/i.test(sql))
        return [
          ["r-1", "critical", 2],
          ["r-1", "low", 1],
        ];
      return [flatten(repos, REPO_VALUES), flatten(repos, REPO_2)];
    };
  }

  it("assembles per-repo ecosystems, severity counts, and bookmark flags", async () => {
    const { db } = makeDb(summaryRouter([["r-1"]]));
    const result = await getReposWithMissionSummary(db, "octocat");

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: "r-1",
      ecosystems: ["npm"],
      missionCounts: { critical: 2, low: 1, total: 3 },
      isBookmarked: true,
    });
    expect(result[1]).toMatchObject({
      id: "r-2",
      ecosystems: ["go"],
      isBookmarked: false,
    });
    expect(result[1]?.missionCounts.total).toBe(0);
  });

  it("skips the bookmarks query entirely for signed-out visitors", async () => {
    const { db, calls } = makeDb(summaryRouter([]));
    const result = await getReposWithMissionSummary(db);

    expect(calls.some((call) => call.sql.includes("repo_bookmarks"))).toBe(false);
    expect(result.every((repo) => !repo.isBookmarked)).toBe(true);
  });
});
