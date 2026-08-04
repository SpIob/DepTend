/**
 * MissionWriter unit tests
 *
 * The Drizzle DB is replaced with a lightweight stub, same strategy as
 * ingestor/writer.test.ts: chainable mock builder methods, call-order-based
 * dispatch for select() (repo lookup -> candidate join -> one mission
 * existence check per candidate, in loop order), and a transaction mock
 * that runs the callback synchronously against the same stub db.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { getTableName, type Table } from "drizzle-orm";
import { MissionWriter } from "./writer.js";
import { missions, missionScores } from "../db/schema.js";

type WriterDb = ConstructorParameters<typeof MissionWriter>[0];

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------

interface WhereResult extends Promise<unknown[]> {
  limit: (n: number) => Promise<unknown[]>;
}

function thenableRows(rows: unknown[]): WhereResult {
  const promise = Promise.resolve(rows) as WhereResult;
  promise.limit = (): Promise<unknown[]> => Promise.resolve(rows);
  return promise;
}

interface Chain {
  from: (table?: Table) => Chain;
  innerJoin: (table: Table, condition?: unknown) => Chain;
  where: (condition?: unknown) => WhereResult;
  limit: (n: number) => Promise<unknown[]>;
  values: (v: unknown) => Chain;
  onConflictDoUpdate: (v: unknown) => Promise<unknown[]>;
  set: (v: unknown) => Chain;
  returning: (v?: unknown) => Promise<unknown[]>;
}

interface MockDbCalls {
  inserts: string[];
  updates: string[];
  selectCount: number;
  transactionCalled: boolean;
  /** Captured values() argument for every mission_scores insert, in candidate order — lets tests inspect the real, unmocked computeMissionScore() output (ADR 0029). */
  insertedScoreValues: Record<string, unknown>[];
}

function makeMockDb(overrides: {
  repoRow?: Record<string, unknown>;
  candidateRows?: { dependency: Record<string, unknown>; advisory: Record<string, unknown> }[];
  /** One entry per candidate, in loop order: null = no existing mission (insert path) */
  existingMissionRows?: ({ id: string } | null)[];
  /** ids returned by the missions insert, consumed in order for candidates with no existing mission */
  insertedMissionIds?: string[];
  txShouldThrow?: boolean;
  /** Optional shared array — "fetch" is pushed by the test's own fetch mock, "transaction" is pushed here, so tests can assert ordering (ADR 0029: prefetch must happen before the transaction opens). */
  callOrder?: string[];
}): { db: WriterDb; calls: MockDbCalls } {
  const {
    repoRow,
    candidateRows = [],
    existingMissionRows = [],
    insertedMissionIds = [],
    txShouldThrow = false,
    callOrder,
  } = overrides;

  const calls: MockDbCalls = {
    inserts: [],
    updates: [],
    selectCount: 0,
    transactionCalled: false,
    insertedScoreValues: [],
  };

  let insertedIdQueueIndex = 0;

  function makeChain(currentTable: Table | undefined): Chain {
    const chain: Chain = {
      from: (table?: Table): Chain => makeChain(table ?? currentTable),
      innerJoin: (): Chain => chain,
      where: (): WhereResult => {
        // Dispatch purely on selectCount, matching the exact call order
        // generateMissionsForRepo makes: 1) repo lookup, 2) candidate join,
        // 3..N) one mission-existence check per candidate.
        if (calls.selectCount === 1) {
          return thenableRows(repoRow !== undefined ? [repoRow] : []);
        }
        if (calls.selectCount === 2) {
          return thenableRows(candidateRows);
        }
        const missionCheckIndex = calls.selectCount - 3;
        const existing = existingMissionRows[missionCheckIndex] ?? null;
        return thenableRows(existing === null ? [] : [existing]);
      },
      limit: (): Promise<unknown[]> => Promise.resolve([]),
      values: (v: unknown): Chain => {
        if (
          currentTable !== undefined &&
          getTableName(currentTable) === getTableName(missionScores)
        ) {
          calls.insertedScoreValues.push(v as Record<string, unknown>);
        }
        return chain;
      },
      onConflictDoUpdate: (): Promise<unknown[]> => Promise.resolve([]),
      set: (): Chain => chain,
      returning: (): Promise<unknown[]> => {
        if (currentTable !== undefined && getTableName(currentTable) === getTableName(missions)) {
          const id = insertedMissionIds[insertedIdQueueIndex];
          insertedIdQueueIndex++;
          return Promise.resolve(id !== undefined ? [{ id }] : []);
        }
        return Promise.resolve([]);
      },
    };
    return chain;
  }

  const db = {
    select: vi.fn((): Chain => {
      calls.selectCount++;
      return makeChain(undefined);
    }),
    insert: vi.fn((table: Table): Chain => {
      calls.inserts.push(getTableName(table));
      return makeChain(table);
    }),
    update: vi.fn((table: Table): Chain => {
      calls.updates.push(getTableName(table));
      return makeChain(table);
    }),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      calls.transactionCalled = true;
      callOrder?.push("transaction");
      if (txShouldThrow) throw new Error("DB transaction failed");
      return callback(db);
    }),
  };

  return { db: db as unknown as WriterDb, calls };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_ROW = {
  id: "repo-1",
  githubUrl: "https://github.com/example/example",
  owner: "example",
  name: "example",
  defaultBranch: "main",
  description: null,
  stars: 1000,
  openIssuesCount: 100,
  topics: [],
  homepageUrl: null,
  ingestionStatus: "complete",
  lastIngestedAt: new Date("2026-07-01"),
  ingestionError: null,
  submittedBy: null,
  createdAt: new Date("2026-06-01"),
  updatedAt: new Date("2026-07-01"),
};

function makeDependencyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dep-1",
    repoId: "repo-1",
    ecosystem: "npm",
    packageName: "left-pad",
    versionSpec: "^1.2.3",
    resolvedVersion: null,
    depType: "production",
    latestVersion: "1.4.0",
    isDeprecated: false,
    deprecationNote: null,
    createdAt: new Date("2026-06-01"),
    updatedAt: new Date("2026-06-01"),
    ...overrides,
  };
}

function makeAdvisoryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "adv-1",
    osvId: "GHSA-xxxx-xxxx-xxxx",
    source: "osv",
    ecosystem: "npm",
    packageName: "left-pad",
    severity: "high",
    cvssScore: 7.5,
    summary: "Example advisory",
    details: null,
    affectedVersions: [],
    fixedVersion: "1.2.4",
    publishedAt: new Date("2026-06-01"),
    modifiedAt: null,
    rawData: {},
    createdAt: new Date("2026-06-01"),
    updatedAt: new Date("2026-06-01"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MissionWriter.generateMissionsForRepo", () => {
  it("throws when the repo does not exist", async () => {
    const { db } = makeMockDb({ candidateRows: [] });
    const writer = new MissionWriter(db);
    await expect(writer.generateMissionsForRepo("missing-repo")).rejects.toThrow(/no repo found/);
  });

  it("returns zero counts when there are no is_affected candidates", async () => {
    const { db, calls } = makeMockDb({ repoRow: REPO_ROW, candidateRows: [] });
    const writer = new MissionWriter(db);
    const result = await writer.generateMissionsForRepo("repo-1");

    expect(result).toEqual({ created: 0, updated: 0, candidatesFound: 0 });
    expect(calls.transactionCalled).toBe(true);
  });

  it("inserts a new mission and its score when no existing mission is found", async () => {
    const { db, calls } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
      existingMissionRows: [null],
      insertedMissionIds: ["mission-1"],
    });
    const writer = new MissionWriter(db);
    const result = await writer.generateMissionsForRepo("repo-1");

    expect(result).toEqual({ created: 1, updated: 0, candidatesFound: 1 });
    expect(calls.inserts).toContain(getTableName(missions));
    expect(calls.inserts).toContain(getTableName(missionScores));
    expect(calls.updates).not.toContain(getTableName(missions));
  });

  it("updates an existing mission's copy without touching status/claim fields", async () => {
    const { db, calls } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
      existingMissionRows: [{ id: "existing-mission-1" }],
    });
    const writer = new MissionWriter(db);
    const result = await writer.generateMissionsForRepo("repo-1");

    expect(result).toEqual({ created: 0, updated: 1, candidatesFound: 1 });
    expect(calls.updates).toContain(getTableName(missions));
    expect(calls.inserts).not.toContain(getTableName(missions));
    // mission_scores is always written via insert().onConflictDoUpdate(),
    // never a plain update() — see writer.ts.
    expect(calls.inserts).toContain(getTableName(missionScores));
  });

  it("processes multiple candidates and reports mixed created/updated counts", async () => {
    const { db, calls } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [
        {
          dependency: makeDependencyRow({ id: "dep-1", packageName: "left-pad" }),
          advisory: makeAdvisoryRow({ id: "adv-1", osvId: "GHSA-aaaa" }),
        },
        {
          dependency: makeDependencyRow({ id: "dep-2", packageName: "right-pad" }),
          advisory: makeAdvisoryRow({ id: "adv-2", osvId: "GHSA-bbbb" }),
        },
      ],
      existingMissionRows: [null, { id: "existing-mission-2" }],
      insertedMissionIds: ["mission-1"],
    });
    const writer = new MissionWriter(db);
    const result = await writer.generateMissionsForRepo("repo-1");

    expect(result).toEqual({ created: 1, updated: 1, candidatesFound: 2 });
    expect(calls.inserts.filter((name) => name === getTableName(missions))).toHaveLength(1);
    expect(calls.updates.filter((name) => name === getTableName(missions))).toHaveLength(1);
    expect(calls.inserts.filter((name) => name === getTableName(missionScores))).toHaveLength(2);
  });

  it("wraps all writes in a single transaction", async () => {
    const { db, calls } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
      existingMissionRows: [null],
      insertedMissionIds: ["mission-1"],
    });
    const writer = new MissionWriter(db);
    await writer.generateMissionsForRepo("repo-1");
    expect(calls.transactionCalled).toBe(true);
  });

  it("propagates a transaction failure", async () => {
    const { db } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
      txShouldThrow: true,
    });
    const writer = new MissionWriter(db);
    await expect(writer.generateMissionsForRepo("repo-1")).rejects.toThrow("DB transaction failed");
  });
});

// ---------------------------------------------------------------------------
// ADR 0029, Step 5 — prefetch integration
// ---------------------------------------------------------------------------

describe("MissionWriter.generateMissionsForRepo — effortSignals prefetch (ADR 0029)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makes zero fetch calls and writes the pre-Step-5 defaults when sourceRepoByPackage is omitted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { db, calls } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
      existingMissionRows: [null],
      insertedMissionIds: ["mission-1"],
    });
    const writer = new MissionWriter(db);
    await writer.generateMissionsForRepo("repo-1");

    expect(fetchMock).not.toHaveBeenCalled();
    const scoreValues = calls.insertedScoreValues[0] as {
      effortInputs: { has_migration_guide: boolean; breaking_change_signals: string[] };
      confidenceFlags: Record<string, boolean>;
    };
    expect(scoreValues.effortInputs.has_migration_guide).toBe(false);
    expect(scoreValues.effortInputs.breaking_change_signals).toEqual([]);
    expect(scoreValues.confidenceFlags.breaking_change_signals_unavailable).toBe(true);
  });

  it("threads a resolved effortSignals through to the written mission_scores row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              tag_name: "v1.2.4",
              body: "BREAKING CHANGE: removed foo()",
              prerelease: false,
              draft: false,
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    const { db, calls } = makeMockDb({
      repoRow: REPO_ROW,
      // versionSpec "^1.2.3" -> floor "1.2.3"; advisory.fixedVersion "1.2.4" -> target — the
      // release above sits exactly in (floor, target], so it's in range.
      candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
      existingMissionRows: [null],
      insertedMissionIds: ["mission-1"],
    });
    const writer = new MissionWriter(db);
    const sourceRepoByPackage = new Map([["left-pad", { owner: "left-pad", name: "left-pad" }]]);
    await writer.generateMissionsForRepo("repo-1", sourceRepoByPackage, "gh-token-abc");

    const scoreValues = calls.insertedScoreValues[0] as {
      effortInputs: { has_migration_guide: boolean; breaking_change_signals: string[] };
      confidenceFlags: Record<string, boolean>;
    };
    expect(scoreValues.effortInputs.breaking_change_signals).toEqual(["removed foo()"]);
    expect(scoreValues.confidenceFlags.breaking_change_signals_unavailable).toBeUndefined();
  });

  it("resolves to the unavailable defaults, with zero fetch calls, for a package missing from sourceRepoByPackage", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { db, calls } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [
        { dependency: makeDependencyRow({ packageName: "left-pad" }), advisory: makeAdvisoryRow() },
      ],
      existingMissionRows: [null],
      insertedMissionIds: ["mission-1"],
    });
    const writer = new MissionWriter(db);
    // Map provided, but doesn't contain "left-pad" — a real, expected case
    // (e.g. the registry lookup for that package failed independently).
    const sourceRepoByPackage = new Map([["some-other-package", { owner: "x", name: "y" }]]);
    await writer.generateMissionsForRepo("repo-1", sourceRepoByPackage, null);

    expect(fetchMock).not.toHaveBeenCalled();
    const scoreValues = calls.insertedScoreValues[0] as {
      confidenceFlags: Record<string, boolean>;
    };
    expect(scoreValues.confidenceFlags.breaking_change_signals_unavailable).toBe(true);
  });

  it("prefetches before opening the transaction, not inside it", async () => {
    const callOrder: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callOrder.push("fetch");
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );

    const { db } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
      existingMissionRows: [null],
      insertedMissionIds: ["mission-1"],
      callOrder,
    });
    const writer = new MissionWriter(db);
    const sourceRepoByPackage = new Map([["left-pad", { owner: "left-pad", name: "left-pad" }]]);
    await writer.generateMissionsForRepo("repo-1", sourceRepoByPackage, null);

    expect(callOrder).toEqual(["fetch", "transaction"]);
  });

  it("dedupes two candidates on the same dependency+target into a single fetch call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // Two different advisories on the same dependency, both fixed at the
    // same version — same signal key, should fetch once, not twice.
    const { db } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [
        {
          dependency: makeDependencyRow(),
          advisory: makeAdvisoryRow({ id: "adv-1", osvId: "GHSA-aaaa" }),
        },
        {
          dependency: makeDependencyRow(),
          advisory: makeAdvisoryRow({ id: "adv-2", osvId: "GHSA-bbbb" }),
        },
      ],
      existingMissionRows: [null, null],
      insertedMissionIds: ["mission-1", "mission-2"],
    });
    const writer = new MissionWriter(db);
    const sourceRepoByPackage = new Map([["left-pad", { owner: "left-pad", name: "left-pad" }]]);
    await writer.generateMissionsForRepo("repo-1", sourceRepoByPackage, null);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
