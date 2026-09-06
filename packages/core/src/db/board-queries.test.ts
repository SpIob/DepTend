/**
 * board-queries.ts unit tests
 *
 * Strategy: real Drizzle query building, fake transport. drizzle() accepts
 * any callable client (neon-http's driver just invokes it as
 * `client(sql, params, config)` and reads `.rows` off the result), so the
 * tests hand board-queries.ts a genuine NeonHttpDatabase wired to a vi.fn that
 * records every statement and routes back canned positional-array rows —
 * exactly what the real driver returns under arrayMode. That means the
 * assertions below see the actual SQL text (quoting, casing, expression
 * order) Drizzle will send to Postgres, with no database and no network.
 *
 * The load-bearing invariant this file guards is the ADR 0031 ordering-
 * parity contract: boardOrderBy()'s SQL key sequence must mirror
 * scorer/ranking.ts's rankMissions() (tier bucket -> effort rank ->
 * published_at DESC NULLS LAST -> unique id). The JS side of that contract
 * is owned by ranking.test.ts — when a ranking key changes, both suites
 * must move together (AGENTS.md §2).
 */

import { describe, expect, it } from "vitest";
import {
  BOARD_PAGE_SIZE,
  getBoardMissionsWithScoresPage,
  getRepoBoardPage,
} from "./board-queries.js";
import { getRepoMissionsWithScores, type BoardFilters } from "./queries.js";
import { missions, missionScores, dependencies, repos } from "./schema.js";
import {
  makeDb,
  joinedRow,
  advisoryListColumns,
  ADVISORY_SUMMARY_EXPECTED,
  EMPTY_FILTERS,
  tallyRow,
  boardRouter,
  flatten,
  bySql,
  MISSION_VALUES,
  SCORE_VALUES,
  DEPENDENCY_VALUES,
  REPO_VALUES,
  createReadonlyDb,
} from "./test-utils.js";

// ---------------------------------------------------------------------------
// Ordering parity (ADR 0031 <-> ADR 0017/0018)
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
  function twoRowRouter(): import("./test-utils.js").RowRouter {
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
// Per-repo board page (ADR 0041)
// ---------------------------------------------------------------------------

describe("getRepoBoardPage", () => {
  it("returns paginated BoardPage scoped to one repo with same filter semantics", async () => {
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
    const result = await getRepoBoardPage(
      db,
      "r-1",
      { ...EMPTY_FILTERS, sort: "priority" },
      { limit: 10 },
    );

    expect(result.missions.length).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.facets).toBeDefined();
  });

  it("applies repoScope to both row query and tally", async () => {
    const { db, calls } = makeDb(boardRouter({}));
    await getRepoBoardPage(db, "r-1", EMPTY_FILTERS, { limit: 10 });

    // Both the row query and tally should carry the repo filter
    const repoScoped = calls.filter((call) => call.sql.includes('"missions"."repo_id" = $'));
    expect(repoScoped.length).toBeGreaterThanOrEqual(2);
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
