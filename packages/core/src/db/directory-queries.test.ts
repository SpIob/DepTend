/**
 * directory-queries.ts unit tests
 *
 * Same fake-transport strategy as board-queries.test.ts, using the shared
 * test-utils.ts infrastructure.
 */

import { describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";
import {
  getIndexedRepoCount,
  getTotalRepoCount,
  getSkippedRepos,
  getRepoDirectorySummary,
  getRepoEcosystems,
  getRepoDirectoryBase,
} from "./directory-queries.js";
// eslint-disable-next-line import/no-cycle — ReadonlyDb is defined in queries.ts which re-exports from directory-queries.ts; test file needs the type without creating a runtime cycle
import type { ReadonlyDb } from "./queries.js";
import { notificationSubscriptions, repos } from "./schema.js";
import {
  makeDb,
  flatten,
  bySql,
  REPO_VALUES,
  NOW,
  tallyRow,
  EMPTY_FILTERS,
  boardRouter,
} from "./test-utils.js";
import { getRepoBoardPage } from "./board-queries.js";
import { createReadonlyDb } from "./queries.js";

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

describe("getRepoDirectorySummary", () => {
  function summaryRouter(opts: {
    counts: [number, number];
    skipped: unknown[][];
  }): import("./test-utils.js").RowRouter {
    return (sql: string): unknown[][] => {
      if (sql.includes("count(*) filter")) return [opts.counts];
      if (sql.includes("ingestion_error")) return opts.skipped;
      return [];
    };
  }

  it("combines indexed + total counts and skipped repos in one call", async () => {
    const { db } = makeDb(
      summaryRouter({
        counts: [7, 12],
        skipped: [
          ["octo", "no-manifest", "No package.json found"],
          ["octo", "empty", null],
        ],
      }),
    );
    const summary = await getRepoDirectorySummary(db);

    expect(summary).toEqual({
      indexedCount: 7,
      totalCount: 12,
      skippedRepos: [
        { owner: "octo", name: "no-manifest", reason: "No package.json found" },
        { owner: "octo", name: "empty", reason: null },
      ],
    });
  });

  it("fires both statements in a single round-trip pair (Promise.all)", async () => {
    const { db, calls } = makeDb(
      summaryRouter({
        counts: [0, 0],
        skipped: [],
      }),
    );
    await getRepoDirectorySummary(db);

    const countCalls = calls.filter((c) => c.sql.includes("count(*) filter"));
    const skipCalls = calls.filter((c) => c.sql.includes("ingestion_error"));
    expect(countCalls).toHaveLength(1);
    expect(skipCalls).toHaveLength(1);
    // The count SELECT projects both scalars in one statement — no
    // separate round-trip for indexed vs. total.
    expect(countCalls[0]?.sql).toContain("count(*) filter");
    expect(countCalls[0]?.sql).toContain("count(*)::int");
  });

  it("returns zeros and empty skipped list when the count row is missing", async () => {
    const { db } = makeDb(() => []);
    expect(await getRepoDirectorySummary(db)).toEqual({
      indexedCount: 0,
      totalCount: 0,
      skippedRepos: [],
    });
  });
});

describe("getRepoEcosystems", () => {
  it("returns the distinct ecosystems as stored", async () => {
    const { db } = makeDb(() => [["npm"], ["go"]]);
    expect(await getRepoEcosystems(db, "r-1")).toEqual(["npm", "go"]);
  });
});

describe("getRepoDirectoryBase", () => {
  const REPO_2 = { ...REPO_VALUES, id: "r-2", name: "other" };

  function summaryRouter(
    opts: {
      bookmarks?: unknown[][];
      subscriptions?: unknown[][];
      orgs?: unknown[][];
      severityRows?: unknown[][];
    } = {},
  ): import("./test-utils.js").RowRouter {
    const bookmarks = opts.bookmarks ?? [];
    const subscriptions = opts.subscriptions ?? [];
    const orgs = opts.orgs ?? [];
    const severityRows = opts.severityRows ?? [
      ["r-1", "critical", 2],
      ["r-1", "low", 1],
    ];
    return (sql: string): unknown[][] => {
      if (sql.includes('from "organizations"')) return orgs;
      if (sql.includes("repo_bookmarks")) return bookmarks;
      if (sql.includes("notification_subscriptions")) return subscriptions;
      if (/select distinct/i.test(sql))
        return [
          ["r-1", "npm"],
          ["r-2", "go"],
        ];
      if (/group by/i.test(sql)) return severityRows;
      return [flatten(repos, REPO_VALUES), flatten(repos, REPO_2)];
    };
  }

  it("assembles per-repo ecosystems, severity counts, and bookmark + subscription flags", async () => {
    // The new getSubscribedRepoIds query selects only repo_id, so the mock
    // must return rows with just that column (matching the bookmarks pattern).
    const { db, calls } = makeDb(summaryRouter({ bookmarks: [["r-1"]], subscriptions: [["r-2"]] }));
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

  // ADR 0053: a row whose advisory severity was a SQL NULL used to be
  // grouped under a phantom counts["null"] property because the JS loop
  // did counts[row.severity] += row.count with row.severity === null.
  // After the LEFT JOIN + COALESCE(advisories.severity, 'unknown') rewrite
  // row.severity is the string "unknown" and the bucket lands where the
  // repo-card component (MissionCounts in repo-card.tsx) actually reads
  // it. This test pins that contract.
  it("buckets rows with NULL advisory severity under 'unknown' (ADR 0053)", async () => {
    const { db } = makeDb(
      summaryRouter({
        severityRows: [
          ["r-1", "critical", 1],
          ["r-1", "unknown", 5],
        ],
      }),
    );
    const result = await getRepoDirectoryBase(db);

    expect(result[0]).toMatchObject({
      id: "r-1",
      missionCounts: { critical: 1, unknown: 5, total: 6 },
    });
    // Phantom-bucket regression guard: pre-ADR-0053 the unknown row would
    // land on counts["null"], not on counts.unknown, so total would still
    // be 6 here but unknown would be 0 — and the home-page card would
    // silently show "1 critical" with a real total of 6.
    expect(result[0]?.missionCounts).not.toHaveProperty("null");
  });

  // ADR 0053: the LEFT JOIN + COALESCE rewrite is the load-bearing change.
  // Mocked tests can't observe whether Postgres accepts the COALESCE cast
  // — AGENTS.md §6's "meta-lesson" — so the live-Postgres block at the
  // bottom of this file covers that. This assertion catches the
  // non-SQL-execution drift: the row query must LEFT JOIN advisories and
  // the GROUP BY must use the COALESCE expression, not advisories.severity
  // directly (which is what the pre-fix query did and what dropped the
  // advisory-less missions).
  it("uses LEFT JOIN + COALESCE on the directory's per-severity tally (ADR 0053)", async () => {
    const { db, calls } = makeDb(summaryRouter({}));
    await getRepoDirectoryBase(db);

    const groupByCall = calls.find(
      (call) => /group by/i.test(call.sql) && /missions/i.test(call.sql),
    );
    expect(groupByCall).toBeDefined();
    expect(groupByCall?.sql).toMatch(/left\s+join\s+"advisories"/i);
    expect(groupByCall?.sql).toMatch(/COALESCE\s*\(\s*"advisories"\."severity"/i);
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

// ---------------------------------------------------------------------------
// Live-Postgres check (opt-in) — ADR 0053 verification
//
// The fake transport above can assert SQL TEXT but never whether Postgres
// ACCEPTS it — boardOrderBy() once shipped a COALESCE(advisories.osv_id,
// missions.id) mixing text with uuid that every mocked test passed and that
// took /missions down in production (NeonDbError 42804). When DATABASE_URL
// is set (local dev has it in .env.local), actually execute the directory
// query and verify its totals match the per-repo board page (which uses
// the correct LEFT JOIN + COALESCE). CI runs without DATABASE_URL and
// skips this block.
// ---------------------------------------------------------------------------

const LIVE_DATABASE_URL = process.env.DATABASE_URL ?? "";

describe.skipIf(LIVE_DATABASE_URL === "")(
  "getRepoDirectoryBase against real Postgres (ADR 0053)",
  () => {
    it(
      "returns severity counts that match the per-repo Impact facet (no advisory-less mission is dropped)",
      { timeout: 30_000 },
      async () => {
        const db = createReadonlyDb(LIVE_DATABASE_URL);
        const directory = await getRepoDirectoryBase(db);
        expect(directory.length).toBeGreaterThan(0);

        for (const repo of directory) {
          const perRepoPage = await getRepoBoardPage(
            db,
            repo.id,
            {
              q: "",
              severities: [],
              ecosystems: [],
              efforts: [],
              missionTypes: [],
              sort: "priority",
            },
            { limit: 1000 },
          );
          // The directory card and the per-repo board page both report
          // mission totals derived from the same missions table. Pre-ADR
          // 0053 the directory's INNER JOIN silently dropped advisory-less
          // (dep_update + license_issue + maintenance) missions, so its
          // total would be smaller than the per-repo total on every repo
          // with any advisory-less rows.
          expect(repo.missionCounts.total).toBe(perRepoPage.total);
        }
      },
    );
  },
);
