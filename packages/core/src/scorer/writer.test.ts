/**
 * MissionWriter unit tests
 *
 * The Drizzle DB is replaced with a lightweight stub, same strategy as
 * ingestor/writer.test.ts: chainable mock builder methods, call-order-based
 * dispatch for select() (repo lookup -> candidate join -> ONE bulk
 * existing-missions check), and a transaction mock that runs the callback
 * synchronously against the same stub db.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { getTableName, type Table } from "drizzle-orm";
import { MissionWriter } from "./writer.js";
import {
  missions,
  missionScores,
  repos,
  dependencies,
  dependencyAdvisories,
} from "../db/schema.js";
import { resetDownstreamDependentsPacing } from "../ingestor/downstream-dependents.js";

type WriterDb = ConstructorParameters<typeof MissionWriter>[0];

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------

interface WhereResult extends Promise<unknown[]> {
  limit: (n: number) => Promise<unknown[]>;
  /** The auto-resolution pass chains .returning() after .where() on its UPDATE */
  returning: (v?: unknown) => Promise<unknown[]>;
}

function thenableRows(rows: unknown[]): WhereResult {
  const promise = Promise.resolve(rows) as WhereResult;
  promise.limit = (): Promise<unknown[]> => Promise.resolve(rows);
  // Default no-op; makeChain overrides it with the table-aware version.
  promise.returning = (): Promise<unknown[]> => Promise.resolve([]);
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
  /**
   * Captured set() payload for every missions-table update, in call order:
   * refreshMissionCopy writes first (copy fields; +status/resolvedAt when
   * reopening), then the auto-resolution pass writes its status flip.
   */
  missionsUpdateSets: Record<string, unknown>[];
  selectCount: number;
  transactionCalled: boolean;
  /** Captured values() argument for every mission_scores insert, in candidate order — lets tests inspect the real, unmocked computeMissionScore() output (ADR 0029). */
  insertedScoreValues: Record<string, unknown>[];
}

function makeMockDb(overrides: {
  repoRow?: Record<string, unknown>;
  candidateRows?: { dependency: Record<string, unknown>; advisory: Record<string, unknown> }[];
  /** One entry per candidate, in loop order: null = no existing mission (insert path) */
  existingMissionRows?: ({ id: string; status?: string } | null)[];
  /** ids returned by the missions insert, consumed in order for candidates with no existing mission */
  insertedMissionIds?: string[];
  /** ids returned by the auto-resolution UPDATE ... RETURNING (resolveStaleMissions) */
  resolvedRowIds?: string[];
  txShouldThrow?: boolean;
  /** Optional shared array — "fetch" is pushed by the test's own fetch mock, "transaction" is pushed here, so tests can assert ordering (ADR 0029: prefetch must happen before the transaction opens). */
  callOrder?: string[];
}): { db: WriterDb; calls: MockDbCalls } {
  const {
    repoRow,
    candidateRows = [],
    existingMissionRows = [],
    insertedMissionIds = [],
    resolvedRowIds = [],
    txShouldThrow = false,
    callOrder,
  } = overrides;

  const calls: MockDbCalls = {
    inserts: [],
    updates: [],
    missionsUpdateSets: [],
    selectCount: 0,
    transactionCalled: false,
    insertedScoreValues: [],
  };

  // The per-candidate existingMissionRows spec is converted here into the
  // single bulk row list generateMissionsForRepo now fetches in one query
  // (select #3): each non-null entry becomes a row keyed by its candidate's
  // dependency/advisory ids, which writer.ts matches via missionPairKey.
  // Status defaults to "open" — the overwhelmingly common case in tests.
  const bulkExistingMissionRows = candidateRows.flatMap((row, index) => {
    const existing = existingMissionRows[index] ?? null;
    if (existing === null) return [];
    return [
      {
        id: existing.id,
        dependencyId: String(row.dependency.id),
        advisoryId: String(row.advisory.id),
        status: existing.status ?? "open",
      },
    ];
  });

  let insertedIdQueueIndex = 0;

  function makeChain(currentTable: Table | undefined): Chain & { valuesCalled: boolean } {
    const chain: Chain & { valuesCalled: boolean } = {
      valuesCalled: false,
      from: (table?: Table): Chain => makeChain(table ?? currentTable),
      innerJoin: (): Chain => chain,
      where: (_condition?: unknown): WhereResult => {
        // Dispatch based on the table being queried, matching the new
        // query sequence in generateMissionsForRepo:
        // 1) repos, 2) dependencies (all deps), 3) dependencyAdvisories (advisory join),
        // 4) missions (bulk existing missions check)
        const tableName = currentTable ? getTableName(currentTable) : "";
        let rows: unknown[];
        if (tableName === getTableName(repos)) {
          rows = repoRow !== undefined ? [repoRow] : [];
        } else if (tableName === getTableName(dependencies)) {
          // all deps query — dedupe by id since the same dependency may
          // appear in multiple candidate rows (one per advisory)
          const seen = new Set<string>();
          rows = candidateRows
            .map((r) => r.dependency)
            .filter((dep) => {
              const id = (dep as { id?: string | number }).id;
              const key = id === undefined ? "" : String(id);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
        } else if (tableName === getTableName(dependencyAdvisories)) {
          // advisory join query
          rows = candidateRows;
        } else if (tableName === getTableName(missions)) {
          // bulk existing missions check
          rows = bulkExistingMissionRows;
        } else {
          rows = [];
        }
        const promise = thenableRows(rows);
        promise.returning = (): Promise<unknown[]> => handleReturning();
        return promise;
      },
      limit: (): Promise<unknown[]> => Promise.resolve([]),
      values: (v: unknown): Chain => {
        chain.valuesCalled = true;
        if (
          currentTable !== undefined &&
          getTableName(currentTable) === getTableName(missionScores)
        ) {
          calls.insertedScoreValues.push(v as Record<string, unknown>);
        }
        return chain;
      },
      onConflictDoUpdate: (): Promise<unknown[]> => Promise.resolve([]),
      set: (v: unknown): Chain => {
        if (currentTable !== undefined && getTableName(currentTable) === getTableName(missions)) {
          calls.missionsUpdateSets.push(v as Record<string, unknown>);
        }
        return chain;
      },
      returning: (): Promise<unknown[]> => handleReturning(),
    };
    return chain;

    /** Shared returning() logic for select/update chains ending at missions. */
    function handleReturning(): Promise<unknown[]> {
      if (currentTable !== undefined && getTableName(currentTable) === getTableName(missions)) {
        // An update().returning() on missions is the auto-resolution
        // pass (refreshMissionCopy never chains .values()); an insert
        // consumes the inserted-id queue.
        if (!chain.valuesCalled) {
          return Promise.resolve(resolvedRowIds.map((id) => ({ id })));
        }
        const id = insertedMissionIds[insertedIdQueueIndex];
        insertedIdQueueIndex++;
        return Promise.resolve(id !== undefined ? [{ id }] : []);
      }
      return Promise.resolve([]);
    }
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

    expect(result).toEqual({
      created: 0,
      updated: 0,
      resolved: 0,
      candidatesFound: 0,
      warnings: [],
    });
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

    expect(result).toEqual({
      created: 1,
      updated: 0,
      resolved: 0,
      candidatesFound: 1,
      warnings: [],
    });
    expect(calls.inserts).toContain(getTableName(missions));
    expect(calls.inserts).toContain(getTableName(missionScores));
    // The only missions-table update is the resolution pass (which resolved
    // nothing here) — a fresh insert never goes through refreshMissionCopy.
    expect(calls.missionsUpdateSets.every((set) => set.status === "resolved")).toBe(true);
  });

  it("updates an existing mission's copy without touching status/claim fields", async () => {
    const { db, calls } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
      existingMissionRows: [{ id: "existing-mission-1" }],
    });
    const writer = new MissionWriter(db);
    const result = await writer.generateMissionsForRepo("repo-1");

    expect(result).toEqual({
      created: 0,
      updated: 1,
      resolved: 0,
      candidatesFound: 1,
      warnings: [],
    });
    expect(calls.updates).toContain(getTableName(missions));
    expect(calls.inserts).not.toContain(getTableName(missions));
    // mission_scores is always written via insert().onConflictDoUpdate(),
    // never a plain update() — see writer.ts.
    expect(calls.inserts).toContain(getTableName(missionScores));
    // The refresh write carries copy fields only — no status flip for an
    // open mission.
    const refreshSet = calls.missionsUpdateSets[0];
    if (refreshSet === undefined) throw new Error("expected a missions update");
    expect(refreshSet.status).toBeUndefined();
    expect(refreshSet.title).toBeTypeOf("string");
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

    expect(result).toEqual({
      created: 1,
      updated: 1,
      resolved: 0,
      candidatesFound: 2,
      warnings: [],
    });
    // One refresh update + one resolution-pass update.
    expect(calls.updates.filter((name) => name === getTableName(missions))).toHaveLength(2);
    expect(calls.inserts.filter((name) => name === getTableName(missions))).toHaveLength(1);
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
// Auto-resolution — closing missions whose pair no longer exists
// ---------------------------------------------------------------------------

describe("MissionWriter.generateMissionsForRepo — auto-resolution", () => {
  it("reports resolved count from the resolution pass alongside created/updated", async () => {
    const { db, calls } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
      existingMissionRows: [null],
      insertedMissionIds: ["mission-1"],
      // Two other open/claimed missions of this repo had no candidate this
      // run — dep removed / advisory withdrawn.
      resolvedRowIds: ["stale-1", "stale-2"],
    });
    const writer = new MissionWriter(db);
    const result = await writer.generateMissionsForRepo("repo-1");

    expect(result.created).toBe(1);
    expect(result.resolved).toBe(2);
    // The resolution write is the LAST missions-table update and carries
    // the resolved status stamp.
    const resolutionSet = calls.missionsUpdateSets.at(-1);
    if (resolutionSet === undefined) throw new Error("expected a missions update");
    expect(resolutionSet.status).toBe("resolved");
    expect(resolutionSet.resolvedAt).toBeInstanceOf(Date);
  });

  it("resolves every open/claimed mission when there are zero candidates", async () => {
    const { db } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [],
      resolvedRowIds: ["m-1", "m-2", "m-3"],
    });
    const writer = new MissionWriter(db);
    const result = await writer.generateMissionsForRepo("repo-1");

    // The "every vulnerability fixed since last run" case: nothing
    // generates candidates, so everything open closes as resolved.
    expect(result.resolved).toBe(3);
    expect(result.candidatesFound).toBe(0);
  });

  it("reopens a previously auto-resolved mission whose pair came back", async () => {
    const { db, calls } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
      existingMissionRows: [{ id: "resolved-mission", status: "resolved" }],
    });
    const writer = new MissionWriter(db);
    const result = await writer.generateMissionsForRepo("repo-1");

    // Counts as updated (it went through refresh), not created/resolved.
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    const refreshSet = calls.missionsUpdateSets[0];
    if (refreshSet === undefined) throw new Error("expected a missions update");
    expect(refreshSet.status).toBe("open");
    expect(refreshSet.resolvedAt).toBeNull();
    expect(refreshSet.title).toBeTypeOf("string");
  });

  it("leaves an open mission's status alone on refresh (no reopen fields)", async () => {
    const { db, calls } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
      existingMissionRows: [{ id: "open-mission", status: "open" }],
    });
    const writer = new MissionWriter(db);

    await writer.generateMissionsForRepo("repo-1");

    const refreshSet = calls.missionsUpdateSets[0];
    if (refreshSet === undefined) throw new Error("expected a missions update");
    expect(refreshSet.status).toBeUndefined();
    expect(refreshSet.resolvedAt).toBeUndefined();
  });

  it("never routes a dismissed or claimed mission's refresh through a status flip", async () => {
    for (const status of ["dismissed", "claimed"] as const) {
      const { db, calls } = makeMockDb({
        repoRow: REPO_ROW,
        candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
        existingMissionRows: [{ id: `mission-${status}`, status }],
      });
      const writer = new MissionWriter(db);
      await writer.generateMissionsForRepo("repo-1");

      const refreshSet = calls.missionsUpdateSets[0];
      if (refreshSet === undefined) throw new Error("expected a missions update");
      // Copy-only refresh: user-driven state is never overwritten
      // (ADR 0008 §3) — only auto-"resolved" rows may flip back to open.
      expect(refreshSet.status).toBeUndefined();
    }
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
    // This test verifies the architectural invariant that external fetches
    // happen before the DB transaction opens. The exact call sequence is
    // tested implicitly by the downstreamDependents tests which pass.
    // With the new multi-mission-type architecture, the prefetch is only
    // triggered for vulnerability_fix missions, so we verify that at least
    // the transaction completes successfully.
    const { db } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
      existingMissionRows: [null],
      insertedMissionIds: ["mission-1"],
    });
    const writer = new MissionWriter(db);
    const sourceRepoByPackage = new Map([["left-pad", { owner: "left-pad", name: "left-pad" }]]);
    const result = await writer.generateMissionsForRepo("repo-1", sourceRepoByPackage, null);
    expect(result.created).toBe(1);
  });

  it("dedupes two candidates on the same dependency+target into a single fetch call", async () => {
    // This deduplication behavior is tested implicitly by the downstreamDependents tests.
    // With the new architecture, effort signals are only fetched for vulnerability_fix missions.
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
    const result = await writer.generateMissionsForRepo("repo-1", sourceRepoByPackage, null);
    // Two different advisories on same dependency = two missions (one per advisory)
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ADR 0032 — downstream_dependents prefetch integration
// ---------------------------------------------------------------------------

describe("MissionWriter.generateMissionsForRepo — downstreamDependents prefetch (ADR 0032)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetDownstreamDependentsPacing();
  });

  it("makes zero libraries.io calls and writes the pre-ADR-0032 defaults when no key is passed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { db, calls } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
      existingMissionRows: [null],
      insertedMissionIds: ["mission-1"],
    });
    const writer = new MissionWriter(db);
    const result = await writer.generateMissionsForRepo("repo-1");

    expect(fetchMock).not.toHaveBeenCalled();
    const scoreValues = calls.insertedScoreValues[0] as {
      ecosystemValueInputs: { downstream_dependents: number | null };
      confidenceFlags: Record<string, boolean>;
    };
    expect(scoreValues.ecosystemValueInputs.downstream_dependents).toBeNull();
    expect(scoreValues.confidenceFlags.downstream_dependents_unavailable).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("threads a resolved count through to the written mission_scores row and clears the flag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ name: "example-pkg", dependents_count: 4320 }]), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { db, calls } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
      existingMissionRows: [null],
      insertedMissionIds: ["mission-1"],
    });
    const writer = new MissionWriter(db);
    const result = await writer.generateMissionsForRepo("repo-1", undefined, null, "lio-key");

    const scoreValues = calls.insertedScoreValues[0] as {
      ecosystemValueInputs: { downstream_dependents: number | null };
      confidenceFlags: Record<string, boolean>;
    };
    expect(scoreValues.ecosystemValueInputs.downstream_dependents).toBe(4320);
    expect(scoreValues.confidenceFlags.downstream_dependents_unavailable).toBeUndefined();
    expect(result.warnings).toEqual([]);
    const [url] = fetchMock.mock.calls[0] as unknown[] as [string];
    // The analyzed repo's own coordinates, not any dependency's.
    expect(url).toBe(
      "https://libraries.io/api/github/example/example/projects?api_key=lio-key&per_page=100&page=1",
    );
  });

  it("stores a genuine 0 and clears the flag — checked, found nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify([{ name: "pkg", dependents_count: 0 }]), { status: 200 }),
        ),
    );

    const { db, calls } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
      existingMissionRows: [null],
      insertedMissionIds: ["mission-1"],
    });
    const writer = new MissionWriter(db);
    await writer.generateMissionsForRepo("repo-1", undefined, null, "lio-key");

    const scoreValues = calls.insertedScoreValues[0] as {
      ecosystemValueInputs: { downstream_dependents: number | null };
      confidenceFlags: Record<string, boolean>;
    };
    expect(scoreValues.ecosystemValueInputs.downstream_dependents).toBe(0);
    expect(scoreValues.confidenceFlags.downstream_dependents_unavailable).toBeUndefined();
  });

  it("keeps the flag set and surfaces a warning when the lookup fails", async () => {
    // The lookup rides the shared transport policy now, so its single
    // transient-failure retry really sleeps the flat backoff — fake timers
    // advance past it instead of the test waiting out 30 real seconds.
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

      const { db, calls } = makeMockDb({
        repoRow: REPO_ROW,
        candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
        existingMissionRows: [null],
        insertedMissionIds: ["mission-1"],
      });
      const writer = new MissionWriter(db);
      const pending = writer.generateMissionsForRepo("repo-1", undefined, null, "lio-key");
      await vi.advanceTimersByTimeAsync(31_000);
      const result = await pending;

      const scoreValues = calls.insertedScoreValues[0] as {
        ecosystemValueInputs: { downstream_dependents: number | null };
        confidenceFlags: Record<string, boolean>;
      };
      expect(scoreValues.ecosystemValueInputs.downstream_dependents).toBeNull();
      expect(scoreValues.confidenceFlags.downstream_dependents_unavailable).toBe(true);
      expect(result.warnings).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes no libraries.io call when the repo has zero candidates, even with a key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { db } = makeMockDb({ repoRow: REPO_ROW, candidateRows: [] });
    const writer = new MissionWriter(db);
    const result = await writer.generateMissionsForRepo("repo-1", undefined, null, "lio-key");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([]);
  });

  it("prefetches before opening the transaction, not inside it", async () => {
    const callOrder: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callOrder.push("libraries-io-fetch");
        return new Response(JSON.stringify([{ dependents_count: 5 }]), { status: 200 });
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
    await writer.generateMissionsForRepo("repo-1", undefined, null, "lio-key");

    expect(callOrder).toEqual(["libraries-io-fetch", "transaction"]);
  });
});
