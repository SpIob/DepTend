/**
 * missions.ts unit tests
 *
 * Same chainable-stub mocking strategy as repos.test.ts, sized to this
 * file's actual call shape: one guarded update().set().where().returning()
 * call, followed by an optional select().from().where().limit(1) recheck
 * only when the update matched zero rows.
 */

import { describe, expect, it } from "vitest";
import { claimMission, isValidMissionId, unclaimMission } from "./missions.js";

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

interface Limitable extends Promise<unknown[]> {
  limit: (n: number) => Promise<unknown[]>;
}

function limitable(rows: unknown[]): Limitable {
  const p = Promise.resolve(rows) as Limitable;
  p.limit = (): Promise<unknown[]> => Promise.resolve(rows);
  return p;
}

interface FromResult extends Promise<unknown[]> {
  where: (condition?: unknown) => Limitable;
}

function fromResult(rows: unknown[]): FromResult {
  const p = Promise.resolve(rows) as FromResult;
  p.where = (): Limitable => limitable(rows);
  return p;
}

interface MockDbOptions {
  /** Rows returned by update().set().where().returning() — empty simulates no match. */
  updateResponse: unknown[];
  /** Rows returned by the recheck select().from().where().limit(1) — only consumed if updateResponse is empty. */
  recheckResponse: unknown[];
}

type MissionsDb = Parameters<typeof claimMission>[0];

function makeMockDb(options: MockDbOptions): {
  db: MissionsDb;
  setValues: Record<string, unknown>[];
} {
  const setValues: Record<string, unknown>[] = [];

  const db = {
    update: (): unknown => ({
      set: (
        v: Record<string, unknown>,
      ): { where: () => { returning: () => Promise<unknown[]> } } => {
        setValues.push(v);
        return {
          where: () => ({
            returning: () => Promise.resolve(options.updateResponse),
          }),
        };
      },
    }),
    select: (): unknown => ({
      from: () => fromResult(options.recheckResponse),
    }),
  };

  return { db: db as unknown as MissionsDb, setValues };
}

// ---------------------------------------------------------------------------
// isValidMissionId
// ---------------------------------------------------------------------------

describe("isValidMissionId", () => {
  it.each([
    "550e8400-e29b-41d4-a716-446655440000",
    "00000000-0000-0000-0000-000000000000",
    "550E8400-E29B-41D4-A716-446655440000",
  ])("accepts %s", (id) => {
    expect(isValidMissionId(id)).toBe(true);
  });

  it.each([
    ["not-a-uuid", "garbage input"],
    ["550e8400-e29b-41d4-a716-44665544000", "too short"],
    ["550e8400-e29b-41d4-a716-4466554400001", "too long"],
    ["", "empty string"],
    ["550e8400e29b41d4a716446655440000", "missing hyphens"],
    ["'; DROP TABLE missions; --", "SQL injection attempt"],
  ])("rejects %s (%s)", (id) => {
    expect(isValidMissionId(id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// claimMission
// ---------------------------------------------------------------------------

describe("claimMission", () => {
  it("returns claimed and sets status/claimedBy/claimedAt when the mission is open", async () => {
    const { db, setValues } = makeMockDb({
      updateResponse: [{ id: "mission-1" }],
      recheckResponse: [],
    });

    const result = await claimMission(db, "mission-1", "octocat");

    expect(result).toBe("claimed");
    expect(setValues).toHaveLength(1);
    expect(setValues[0]).toMatchObject({ status: "claimed", claimedBy: "octocat" });
    expect(setValues[0]?.claimedAt).toBeInstanceOf(Date);
  });

  it("returns already_claimed when the update matches nothing but the mission exists", async () => {
    const { db } = makeMockDb({
      updateResponse: [],
      recheckResponse: [{ id: "mission-1" }],
    });

    const result = await claimMission(db, "mission-1", "octocat");

    expect(result).toBe("already_claimed");
  });

  it("returns not_found when the update matches nothing and the mission doesn't exist", async () => {
    const { db } = makeMockDb({
      updateResponse: [],
      recheckResponse: [],
    });

    const result = await claimMission(db, "does-not-exist", "octocat");

    expect(result).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// unclaimMission
// ---------------------------------------------------------------------------

describe("unclaimMission", () => {
  it("returns unclaimed and clears status/claimedBy/claimedAt when the caller owns the claim", async () => {
    const { db, setValues } = makeMockDb({
      updateResponse: [{ id: "mission-1" }],
      recheckResponse: [],
    });

    const result = await unclaimMission(db, "mission-1", "octocat");

    expect(result).toBe("unclaimed");
    expect(setValues).toEqual([{ status: "open", claimedBy: null, claimedAt: null }]);
  });

  it("returns not_claimed_by_you when the mission is claimed by someone else", async () => {
    const { db } = makeMockDb({
      updateResponse: [],
      recheckResponse: [{ id: "mission-1" }],
    });

    const result = await unclaimMission(db, "mission-1", "someone-else");

    expect(result).toBe("not_claimed_by_you");
  });

  it("returns not_claimed_by_you when the mission is currently open (nothing to release)", async () => {
    const { db } = makeMockDb({
      updateResponse: [],
      recheckResponse: [{ id: "mission-1" }],
    });

    const result = await unclaimMission(db, "mission-1", "octocat");

    expect(result).toBe("not_claimed_by_you");
  });

  it("returns not_found when the mission doesn't exist", async () => {
    const { db } = makeMockDb({
      updateResponse: [],
      recheckResponse: [],
    });

    const result = await unclaimMission(db, "does-not-exist", "octocat");

    expect(result).toBe("not_found");
  });
});
