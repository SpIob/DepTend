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
  createReadonlyDb,
  getBoardMissionsWithScoresPage,
  getIndexedRepoCount,
  getRepoDirectoryBase,
  getRepoEcosystems,
  getRepoMissionsWithScores,
  getSkippedRepos,
  getTotalRepoCount,
  type BoardFilters,
  type ReadonlyDb,
} from "./queries.js";
import {
  dependencies,
  missions,
  missionScores,
  notificationSubscriptions,
  repos,
} from "./schema.js";

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
  orgId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

/**
 * The advisory segment of a joined row, positional order matching
 * queries.ts's advisoryListSelection — the driver maps rows against the
 * SELECT list, so this must track it (see the projection test below).
 */
function advisoryListColumns(): unknown[] {
  return [
    ADVISORY_VALUES.id,
    ADVISORY_VALUES.osvId,
    ADVISORY_VALUES.source,
    ADVISORY_VALUES.ecosystem,
    ADVISORY_VALUES.severity,
    ADVISORY_VALUES.fixedVersion,
    ADVISORY_VALUES.publishedAt,
  ];
}

/** Expected AdvisorySummary shape for ADVISORY_VALUES. */
const ADVISORY_SUMMARY_EXPECTED = {
  id: ADVISORY_VALUES.id,
  osvId: ADVISORY_VALUES.osvId,
  source: ADVISORY_VALUES.source,
  ecosystem: ADVISORY_VALUES.ecosystem,
  severity: ADVISORY_VALUES.severity,
  fixedVersion: ADVISORY_VALUES.fixedVersion,
  publishedAt: ADVISORY_VALUES.publishedAt,
};

/** One fully-populated five-table join row, in driver positional order. */
function joinedRow(): unknown[] {
  return [
    ...flatten(missions, MISSION_VALUES),
    ...flatten(missionScores, SCORE_VALUES),
    ...advisoryListColumns(),
    ...flatten(dependencies, DEPENDENCY_VALUES),
    ...flatten(repos, REPO_VALUES),
  ];
}

const EMPTY_FILTERS: BoardFilters = {
  q: "",
  severities: [],
  ecosystems: [],
  efforts: [],
  missionTypes: [],
  sort: "priority",
};

/**
 * One row for the merged tally statement: [total, then one count column per
 * known severity, ecosystem, and effort enum value] — 13 columns, in the
 * same order queries.ts builds its select object.
 */
function tallyRow(overrides: Partial<Record<string, number>> = {}): unknown[] {
  const values: Record<string, number> = {
    total: 0,
    severity_critical: 0,
    severity_high: 0,
    severity_medium: 0,
    severity_low: 0,
    severity_unknown: 0,
    ecosystem_npm: 0,
    ecosystem_pypi: 0,
    ecosystem_go: 0,
    effort_trivial: 0,
    effort_low: 0,
    effort_medium: 0,
    effort_high: 0,
    ...overrides,
  };
  return Object.values(values);
}

/** Default routing for the board query's two parallel statements. */
function boardRouter(overrides: Partial<Record<"page" | "tally", unknown[][]>>): RowRouter {
  return (sql: string): unknown[][] => {
    if (sql.includes("limit ")) return overrides.page ?? [joinedRow()];
    if (sql.includes("count(*)")) return overrides.tally ?? [tallyRow({ total: 3 })];
    return [];
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
    const unique = sql.indexOf('COALESCE("advisories"."osv_id", "missions"."id"::text) ASC');

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
    const unique = sql.indexOf('COALESCE("advisories"."osv_id", "missions"."id"::text) ASC');

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
    const unique = sql.indexOf('COALESCE("advisories"."osv_id", "missions"."id"::text) ASC');

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

  it("binds set filters once on the merged tally, each axis's FILTER ignoring only its own axis", async () => {
    const filters: BoardFilters = {
      q: "lodash",
      severities: ["high", "critical"],
      ecosystems: ["npm"],
      efforts: ["trivial"],
      missionTypes: [],
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

    // Total + facets come out of ONE statement (a single join scan with
    // count(*) FILTER columns), not four parallel statements.
    const tallyCalls = calls.filter((call) => call.sql.includes("filter (where"));
    expect(tallyCalls).toHaveLength(1);
    const tally = bySql(calls, /filter \(where/);

    // Every filter value is bound once on the shared statement.
    for (const value of [
      ...filters.severities,
      ...filters.ecosystems,
      ...filters.efforts,
      "%lodash%",
    ]) {
      expect(tally.params).toContain(value);
    }

    // One FILTER column per known enum value plus the total:
    // 5 severities + 3 ecosystems + 4 efforts + 4 missionTypes + 1 total.
    expect(tally.sql.match(/filter \(where/g)).toHaveLength(17);

    // Each facet bucket is an equality against its own expression — the
    // facet answers "how many rows are this severity under the other
    // axes' filters", not a re-application of that axis's IN list.
    const selectList = tally.sql.slice(tally.sql.indexOf("select"), tally.sql.indexOf(" from "));
    expect(
      selectList.match(/coalesce\("advisories"\."severity"::text, 'unknown'\) = /gi),
    ).toHaveLength(5);
    expect(
      selectList.match(/coalesce\("dependencies"\."ecosystem"::text[^)]*\) = /gi),
    ).toHaveLength(3);
  });

  it("ships the narrow advisory projection — no raw OSV blob or long-form fields", async () => {
    const { db, calls } = makeDb(boardRouter({}));
    await getBoardMissionsWithScoresPage(db, EMPTY_FILTERS);
    await getRepoMissionsWithScores(db, "r-1");

    for (const call of calls) {
      if (!call.sql.includes('from "missions"') || call.sql.includes("count(*)")) {
        continue; // only the payload join statements are under test
      }
      expect(call.sql).toContain('"advisories"."osv_id"');
      expect(call.sql).not.toContain('"advisories"."raw_data"');
      expect(call.sql).not.toContain('"advisories"."details"');
      expect(call.sql).not.toContain('"advisories"."affected_versions"');
      expect(call.sql).not.toContain('"advisories"."summary"');
      expect(call.sql).not.toContain('"advisories"."package_name"');
    }
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
  it("maps the join row into MissionWithScore and reads facets off the merged tally", async () => {
    const { db } = makeDb(
      boardRouter({
        tally: [
          tallyRow({
            total: 3,
            severity_high: 2,
            severity_low: 1,
            ecosystem_npm: 3,
            effort_low: 3,
          }),
        ],
      }),
    );
    const result = await getBoardMissionsWithScoresPage(db, EMPTY_FILTERS);

    expect(result.total).toBe(3);
    expect(result.missions).toEqual([
      {
        ...MISSION_VALUES,
        score: SCORE_VALUES,
        advisory: ADVISORY_SUMMARY_EXPECTED,
        dependency: DEPENDENCY_VALUES,
        repo: REPO_VALUES,
      },
    ]);
    // Zero-count buckets are omitted, matching the GROUP BY behavior the
    // tally statement replaced (a chip with no rows shows no count).
    expect(result.facets.severity).toEqual({ high: 2, low: 1 });
    expect(result.facets.ecosystem).toEqual({ npm: 3 });
    expect(result.facets.effort).toEqual({ low: 3 });
  });

  it("normalizes an all-null left-join advisory projection to null on the shaped row", async () => {
    // A mission with no advisory_id joins nothing — the driver hands back
    // NULLs for every selected advisory column, which must surface as
    // advisory: null, not an object of nulls.
    const { db } = makeDb(() => [
      [
        ...flatten(missions, MISSION_VALUES),
        ...flatten(missionScores, SCORE_VALUES),
        ...advisoryListColumns().map(() => null),
        ...flatten(dependencies, DEPENDENCY_VALUES),
        ...flatten(repos, REPO_VALUES),
      ],
    ]);
    const result = await getRepoMissionsWithScores(db, "r-1");

    expect(result).toHaveLength(1);
    expect(result[0]?.advisory).toBeNull();
  });

  it("returns zero total and empty facets when the board has no matching rows", async () => {
    const { db } = makeDb(boardRouter({ page: [], tally: [tallyRow()] }));
    const result = await getBoardMissionsWithScoresPage(db, EMPTY_FILTERS);

    expect(result.total).toBe(0);
    expect(result.missions).toEqual([]);
    expect(result.facets).toEqual({ severity: {}, ecosystem: {}, effort: {}, missionType: {} });
  });
});

// ---------------------------------------------------------------------------
// Fetch-everything path (per-repo board + JS-side ranking)
// ---------------------------------------------------------------------------

describe("getRepoMissionsWithScores", () => {
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
        ...advisoryListColumns(),
        ...flatten(dependencies, DEPENDENCY_VALUES),
        ...flatten(repos, REPO_VALUES),
      ];
      return [first, second];
    };
  }

  it("ranks rows through rankMissions() (higher composite first despite input order)", async () => {
    const { db } = makeDb(twoRowRouter());
    const result = await getRepoMissionsWithScores(db, "r-1");

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

describe("getRepoDirectoryBase", () => {
  const REPO_2: Record<string, unknown> = { ...REPO_VALUES, id: "r-2", name: "other" };

  function summaryRouter(
    opts: {
      bookmarks?: unknown[][];
      subscriptions?: unknown[][];
      orgs?: unknown[][];
    } = {},
  ): RowRouter {
    const bookmarks = opts.bookmarks ?? [];
    const subscriptions = opts.subscriptions ?? [];
    const orgs = opts.orgs ?? [];
    return (sql: string): unknown[][] => {
      if (sql.includes('from "organizations"')) return orgs;
      if (sql.includes("repo_bookmarks")) return bookmarks;
      if (sql.includes("notification_subscriptions")) return subscriptions;
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

  // The subscriptions table has a text[] event_types column Drizzle's
  // PgArray column deserializer walks, so the row fixture must carry the
  // array in driver shape — the other fixtures use plain string columns
  // and don't trip the deserializer.
  const SUB_ROW = flatten(notificationSubscriptions, {
    id: "s-1",
    userLogin: "octocat",
    repoId: "r-2",
    eventTypes: ["new_mission", "claimed", "resolved"],
    githubIssueNumber: null,
    createdAt: NOW,
  });

  it("assembles per-repo ecosystems, severity counts, and bookmark + subscription flags", async () => {
    const { db } = makeDb(summaryRouter({ bookmarks: [["r-1"]], subscriptions: [SUB_ROW] }));
    const result = await getRepoDirectoryBase(db, { userLogin: "octocat" });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: "r-1",
      ecosystems: ["npm"],
      missionCounts: { critical: 2, low: 1, total: 3 },
      isBookmarked: true,
      isSubscribed: false,
    });
    expect(result[1]).toMatchObject({
      id: "r-2",
      ecosystems: ["go"],
      isBookmarked: false,
      isSubscribed: true,
    });
    expect(result[1]?.missionCounts.total).toBe(0);
  });

  it("skips both the bookmarks and subscriptions queries for signed-out visitors", async () => {
    const { db, calls } = makeDb(summaryRouter({}));
    const result = await getRepoDirectoryBase(db);

    expect(calls.some((call) => call.sql.includes("repo_bookmarks"))).toBe(false);
    expect(calls.some((call) => call.sql.includes("notification_subscriptions"))).toBe(false);
    expect(result.every((repo) => !repo.isBookmarked)).toBe(true);
    expect(result.every((repo) => repo.isSubscribed === undefined)).toBe(true);
  });

  it("applies the org filter to repos, dependencies, and severity counts", async () => {
    const { db, calls } = makeDb(summaryRouter({ orgs: [["o-1"]] }));
    await getRepoDirectoryBase(db, { orgLogin: "spiob" });

    // All three directory-base sub-queries carry the org scope: one
    // targeting repos directly, one inner-joining repos, one inner-joining
    // repos. The pre-merge implementation had the un-scoped variant; that
    // drift was the bug this test guards.
    const repoScoped = calls.filter((call) => call.sql.includes('"repos"."org_id" = $'));
    expect(repoScoped.length).toBeGreaterThanOrEqual(3);
  });

  it("returns an empty list for an unknown orgLogin instead of throwing", async () => {
    const { db } = makeDb(summaryRouter({ orgs: [] }));
    const result = await getRepoDirectoryBase(db, { orgLogin: "does-not-exist" });
    expect(result).toEqual([]);
  });
});

describe("getRepoDirectoryBaseByOrg", () => {
  it("delegates to getRepoDirectoryBase with the orgLogin option", async () => {
    const { db } = makeDb(() => []);
    const { getRepoDirectoryBaseByOrg } = await import("./queries.js");
    const result = await getRepoDirectoryBaseByOrg(db, "spiob");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Live-Postgres check (opt-in)
//
// The fake transport above can assert SQL TEXT but never whether Postgres
// ACCEPTS it — boardOrderBy() once shipped a COALESCE(advisories.osv_id,
// missions.id) mixing text with uuid that every mocked test passed and that
// took /missions down in production (NeonDbError 42804). When DATABASE_URL
// is set (local dev has it in .env.local), actually execute all three sort
// modes so type errors in these statements fail here instead of live. CI
// runs without DATABASE_URL and skips this block.
// ---------------------------------------------------------------------------

const LIVE_DATABASE_URL = process.env.DATABASE_URL ?? "";

describe.skipIf(LIVE_DATABASE_URL === "")(
  "getBoardMissionsWithScoresPage against real Postgres",
  () => {
    it(
      "executes every sort mode's ORDER BY without a Postgres type error",
      { timeout: 30_000 },
      async () => {
        const db = createReadonlyDb(LIVE_DATABASE_URL);
        const baseFilters: BoardFilters = {
          q: "",
          severities: [],
          ecosystems: [],
          efforts: [],
          missionTypes: [],
          sort: "priority",
        };

        for (const sort of ["priority", "quick-wins", "newest"] as const) {
          const page = await getBoardMissionsWithScoresPage(
            db,
            { ...baseFilters, sort },
            {
              limit: 5,
            },
          );
          expect(Array.isArray(page.missions)).toBe(true);
          expect(page.total).toBeGreaterThanOrEqual(0);
        }
      },
    );
  },
);
