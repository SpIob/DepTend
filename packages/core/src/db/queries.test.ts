/**
 * queries.ts unit tests — core join + fetch-everything path only
 *
 * Board pagination tests moved to board-queries.test.ts.
 * Directory/count tests moved to directory-queries.test.ts.
 *
 * This file tests:
 * - missionJoinRows / toMissionWithScore (the shared five-table join)
 * - getRepoMissionsWithScores (fetch-everything + JS-side ranking)
 */

import { describe, expect, it, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import type { PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";
import { getRepoMissionsWithScores, type ReadonlyDb } from "./queries.js";
import { missions, missionScores, dependencies, repos } from "./schema.js";
import {
  makeDb,
  joinedRow,
  advisoryListColumns,
  ADVISORY_SUMMARY_EXPECTED,
  MISSION_VALUES,
  SCORE_VALUES,
  DEPENDENCY_VALUES,
  REPO_VALUES,
  NOW,
  flatten,
  bySql,
} from "./test-utils.js";

// ---------------------------------------------------------------------------
// Shared fixtures (minimal subset needed for these tests)
// ---------------------------------------------------------------------------

// MISSION_VALUES, SCORE_VALUES, ADVISORY_VALUES, DEPENDENCY_VALUES, REPO_VALUES, NOW
// advisoryListColumns, ADVISORY_SUMMARY_EXPECTED, joinedRow, flatten, bySql
// are all re-exported from test-utils.js

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
// Join row projection tests
// ---------------------------------------------------------------------------

describe("missionJoinRows / toMissionWithScore (shared join)", () => {
  it("maps the five-table join row into MissionWithScore with correct advisory projection", async () => {
    const { db } = makeDb(() => [joinedRow()]);
    const result = await getRepoMissionsWithScores(db, "r-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      ...MISSION_VALUES,
      score: SCORE_VALUES,
      advisory: ADVISORY_SUMMARY_EXPECTED,
      dependency: DEPENDENCY_VALUES,
      repo: REPO_VALUES,
    });
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
});
