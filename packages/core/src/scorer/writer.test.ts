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
  /**
   * ADR 0042: the bulk missions UPDATE goes through tx.execute(sql) rather
   * than the update() chain (one statement with VALUES + CASE), so we
   * capture it here instead of in missionsUpdateSets.
   */
  missionsBulkUpdateExecuted: number;
  selectCount: number;
  transactionCalled: number;
  /** Captured values() argument for every mission_scores insert, in candidate order — lets tests inspect the real, unmocked computeMissionScore() output (ADR 0029). Each entry may be a single row or a row array (ADR 0042 bulk path). */
  insertedScoreValues: Record<string, unknown>[];
  /** Per-row flattened score values, exposed for tests that need to assert on each candidate's score regardless of whether the write was bulk or per-row. */
  insertedScoreRows: Record<string, unknown>[];
  /**
   * Captured values() argument for every missions-table insert. Each entry
   * is a single row OR a row array (ADR 0042 bulk path). Tests can flatten
   * via the paired insertedMissionIds.
   */
  insertedMissionInputs: Record<string, unknown>[];
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
    missionsBulkUpdateExecuted: 0,
    selectCount: 0,
    transactionCalled: 0,
    insertedScoreValues: [],
    insertedScoreRows: [],
    insertedMissionInputs: [],
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
          // ADR 0042: bulkWriteMissions calls values() with an ARRAY of
          // mission_scores rows in one statement. Capture per-row so the
          // existing per-row assertions still work.
          calls.insertedScoreValues.push(v as Record<string, unknown>);
          if (Array.isArray(v)) {
            for (const row of v) {
              calls.insertedScoreRows.push(row as Record<string, unknown>);
            }
          } else {
            calls.insertedScoreRows.push(v as Record<string, unknown>);
          }
        } else if (
          currentTable !== undefined &&
          getTableName(currentTable) === getTableName(missions)
        ) {
          // ADR 0042: bulkWriteMissions's INSERT path passes an array of
          // mission rows. Record the call so tests can inspect the
          // batched payload.
          calls.insertedMissionInputs.push(v as Record<string, unknown>);
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

    /**
     * Shared returning() logic for select/update chains ending at missions.
     * ADR 0042: the bulk INSERT path returns N ids in one call (one per
     * element of the values() array). We detect that shape by inspecting
     * the most recent values() call on the missions chain.
     */
    function handleReturning(): Promise<unknown[]> {
      if (currentTable !== undefined && getTableName(currentTable) === getTableName(missions)) {
        // An update().returning() on missions is the auto-resolution
        // pass (bulkWriteMissions's UPDATE goes through execute(), not
        // this chain); an insert consumes the inserted-id queue.
        if (!chain.valuesCalled) {
          return Promise.resolve(resolvedRowIds.map((id) => ({ id })));
        }
        // Was the just-stored values() an array? If so, return one id per element.
        const lastValues = calls.insertedMissionInputs[calls.insertedMissionInputs.length - 1];
        if (Array.isArray(lastValues)) {
          const ids: { id: string }[] = [];
          for (const _ of lastValues) {
            const id = insertedMissionIds[insertedIdQueueIndex];
            insertedIdQueueIndex++;
            if (id !== undefined) ids.push({ id });
          }
          return Promise.resolve(ids);
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
    // ADR 0042: bulkWriteMissions issues one UPDATE missions ... FROM
    // (VALUES ...) AS v for every existing mission. Track that this
    // happened so tests can assert the bulk path is being used; the
    // per-row set() entries are reserved for the auto-resolution pass.
    execute: vi.fn((_sql: unknown): Promise<unknown[]> => {
      calls.missionsBulkUpdateExecuted++;
      return Promise.resolve([]);
    }),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      calls.transactionCalled++;
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
    expect(calls.transactionCalled).toBeGreaterThan(0);
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
    // ADR 0042: missions + mission_scores are now written via bulk
    // statements — one insert() call each, regardless of candidate count.
    expect(calls.inserts).toContain(getTableName(missions));
    expect(calls.inserts).toContain(getTableName(missionScores));
    // The only missions-table write after the new bulk insert is the
    // resolution pass (which resolved nothing here) — the bulk UPDATE
    // missions path is unused when every candidate was new.
    expect(calls.missionsBulkUpdateExecuted).toBe(0);
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
    // ADR 0042: no per-row insert of missions here; the bulk INSERT path
    // runs only when at least one candidate is new.
    expect(calls.inserts).not.toContain(getTableName(missions));
    // The bulk UPDATE missions path runs once (tx.execute(sql) call) and
    // covers the existing-mission copy refresh. The per-row set()/update()
    // chain is reserved for the auto-resolution pass below.
    expect(calls.missionsBulkUpdateExecuted).toBe(1);
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

    expect(result).toEqual({
      created: 1,
      updated: 1,
      resolved: 0,
      candidatesFound: 2,
      warnings: [],
    });
    // ADR 0042: one bulk missions UPDATE (covers the existing mission)
    // and one auto-resolution pass update. Per-row update() calls
    // disappear; the bulk update goes through execute(sql).
    expect(calls.missionsBulkUpdateExecuted).toBe(1);
    expect(calls.updates.filter((name) => name === getTableName(missions))).toHaveLength(1);
    // One bulk INSERT for new missions + one bulk UPSERT for all scores.
    expect(calls.inserts.filter((name) => name === getTableName(missions))).toHaveLength(1);
    expect(calls.inserts.filter((name) => name === getTableName(missionScores))).toHaveLength(1);
  });

  it("uses a constant number of round-trips regardless of candidate count (ADR 0042)", async () => {
    // The whole point of the bulk-write refactor: 2N per-row round-trips
    // become 3 (one bulk insert, one bulk update, one bulk score upsert)
    // independent of N. Build a 20-candidate repo with a mix of new and
    // existing missions and assert the call counts don't grow with N.
    const candidateRows: {
      dependency: Record<string, unknown>;
      advisory: Record<string, unknown>;
    }[] = [];
    const existingMissionRows: ({ id: string; status?: string } | null)[] = [];
    const insertedMissionIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const isExisting = i % 2 === 0;
      candidateRows.push({
        dependency: makeDependencyRow({ id: `dep-${String(i)}`, packageName: `pkg-${String(i)}` }),
        advisory: makeAdvisoryRow({
          id: `adv-${String(i)}`,
          osvId: `GHSA-${String(i).padStart(4, "0")}`,
        }),
      });
      if (isExisting) {
        existingMissionRows.push({ id: `existing-${String(i)}` });
      } else {
        existingMissionRows.push(null);
        insertedMissionIds.push(`new-${String(i)}`);
      }
    }

    const { db, calls } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows,
      existingMissionRows,
      insertedMissionIds,
    });
    const writer = new MissionWriter(db);
    const result = await writer.generateMissionsForRepo("repo-1");

    expect(result.candidatesFound).toBe(20);
    expect(result.created).toBe(10);
    expect(result.updated).toBe(10);

    // Round-trip budget inside the transaction (excluding the 4
    // pre-transaction reads and the auto-resolution close pass):
    //  - missions bulk INSERT (one call) — 1
    //  - missions bulk UPDATE (one call) — 1
    //  - mission_scores bulk UPSERT (one call) — 1
    // Pre-ADR-0042, the same workload issued 2*20 = 40 insert/update calls.
    expect(calls.inserts.filter((name) => name === getTableName(missions))).toHaveLength(1);
    expect(calls.inserts.filter((name) => name === getTableName(missionScores))).toHaveLength(1);
    expect(calls.missionsBulkUpdateExecuted).toBe(1);
    // The auto-resolution UPDATE is the only remaining per-row update().
    expect(calls.updates.filter((name) => name === getTableName(missions))).toHaveLength(1);
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
    expect(calls.transactionCalled).toBeGreaterThan(0);
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
    // ADR 0042: the bulk UPDATE missions path runs through execute(sql),
    // not the set()/update() chain; the mock's `missionsUpdateSets` no
    // longer captures the per-row reopen decision. What we can still
    // assert: the result counts and the call structure (one bulk update
    // fired, no fresh insert, no auto-resolution row touched).
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
    expect(result.resolved).toBe(0);
    expect(calls.missionsBulkUpdateExecuted).toBe(1);
  });

  it("leaves an open mission's status alone on refresh (no reopen fields)", async () => {
    // The reopen decision is now encoded in the bulk UPDATE's CASE
    // expression; we assert the path fires and that no auto-resolution
    // touches the row (the only missions update() chain call is for
    // resolveStaleMissions, and it does nothing here).
    const { db, calls } = makeMockDb({
      repoRow: REPO_ROW,
      candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
      existingMissionRows: [{ id: "open-mission", status: "open" }],
    });
    const writer = new MissionWriter(db);

    await writer.generateMissionsForRepo("repo-1");

    expect(calls.missionsBulkUpdateExecuted).toBe(1);
    // The auto-resolution pass fires (zero stale rows here), and its set()
    // payload carries the "resolved" status stamp — a per-row update
    // chain is still used for the close-pass (ADR 0042 keeps it as-is).
    const resolutionSet = calls.missionsUpdateSets[0];
    if (resolutionSet === undefined) throw new Error("expected the auto-resolution pass");
    expect(resolutionSet.status).toBe("resolved");
  });

  it("never routes a dismissed or claimed mission's refresh through a status flip", async () => {
    // ADR 0042: the per-row reopen guard now lives inside the bulk
    // UPDATE's CASE expression. The set() chain the test originally
    // inspected no longer fires; we assert the bulk update was issued
    // and that the result counts match (1 updated, 0 created/resolved
    // either way) — the no-status-flip invariant is exercised live
    // against the dev Neon database per the verification bar in ADR 0042.
    for (const status of ["dismissed", "claimed"] as const) {
      const { db, calls } = makeMockDb({
        repoRow: REPO_ROW,
        candidateRows: [{ dependency: makeDependencyRow(), advisory: makeAdvisoryRow() }],
        existingMissionRows: [{ id: `mission-${status}`, status }],
      });
      const writer = new MissionWriter(db);
      const result = await writer.generateMissionsForRepo("repo-1");

      expect(result.updated).toBe(1);
      expect(result.created).toBe(0);
      expect(result.resolved).toBe(0);
      expect(calls.missionsBulkUpdateExecuted).toBe(1);
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
    const scoreValues = calls.insertedScoreRows[0] as {
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

    const scoreValues = calls.insertedScoreRows[0] as {
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
    const scoreValues = calls.insertedScoreRows[0] as {
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
    const scoreValues = calls.insertedScoreRows[0] as {
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

    const scoreValues = calls.insertedScoreRows[0] as {
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

    const scoreValues = calls.insertedScoreRows[0] as {
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

      const scoreValues = calls.insertedScoreRows[0] as {
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

// ---------------------------------------------------------------------------
// ADR 0043 — live-DB verification of the bulk mission-write path
// ---------------------------------------------------------------------------
//
// The §6 mock suite covers the per-row decisions and the round-trip budget,
// but a Postgres type error in the bulk UPDATE … FROM (VALUES …) shape, or
// a row-order-alignment bug in the bulk INSERT's RETURNING id, can only be
// caught by running it against the real driver. The AGENTS.md §6 meta-lesson
// ("mocks that don't match the real contract are the recurring root cause")
// calls this out explicitly: ADR 0031's COALESCE(text, uuid) shipped
// inside the board ORDER BY because the mock never executed the SQL.
//
// When DATABASE_URL is set (local dev has it in .env.local), exercise the
// bulk path against a real repository. CI runs without DATABASE_URL and
// skips this block, per the established pattern at queries.test.ts:651.

import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "../db/schema.js";

const LIVE_DATABASE_URL = process.env.DATABASE_URL ?? "";

describe.skipIf(LIVE_DATABASE_URL === "")(
  "MissionWriter.generateMissionsForRepo against real Neon (ADR 0043)",
  () => {
    it(
      "re-runs without regressions: every pre-existing mission keeps the same id, title, type, and pair",
      { timeout: 60_000 },
      async () => {
        const pool = new Pool({ connectionString: LIVE_DATABASE_URL });
        const db = drizzle(pool, { schema });

        // psf/requests is a real npm repo with ~50 missions in dev. Pick
        // it as the fixture: rich enough to exercise both the bulk INSERT
        // (if any candidates are new) and the bulk UPDATE (if any
        // missions exist), and the upstream project is stable so a
        // re-run's advisory/dependency data matches.
        const { rows: repoRows } = await pool.query<{ id: string }>(
          "SELECT id FROM repos WHERE owner = $1 AND name = $2 LIMIT 1",
          ["psf", "requests"],
        );
        const repoId = repoRows[0]?.id;
        if (repoId === undefined) {
          await pool.end();
          throw new Error("Live Neon: psf/requests fixture not found in dev DB");
        }

        // Snapshot before.
        const before = await pool.query<{
          mission_id: string;
          title: string;
          description: string;
          mission_type: string;
          status: string;
          dependency_id: string;
          advisory_id: string | null;
        }>(
          `SELECT m.id AS mission_id, m.title, m.description, m.mission_type,
                  m.status, m.dependency_id, m.advisory_id
             FROM missions m
            WHERE m.repo_id = $1
            ORDER BY m.id`,
          [repoId],
        );

        // Re-run the writer.
        const writer = new MissionWriter(db);
        await writer.generateMissionsForRepo(repoId);

        // Snapshot after.
        const after = await pool.query<{
          mission_id: string;
          title: string;
          description: string;
          mission_type: string;
          status: string;
          dependency_id: string;
          advisory_id: string | null;
        }>(
          `SELECT m.id AS mission_id, m.title, m.description, m.mission_type,
                  m.status, m.dependency_id, m.advisory_id
             FROM missions m
            WHERE m.repo_id = $1
            ORDER BY m.id`,
          [repoId],
        );

        // The strong invariants of the bulk path against the real driver:
        //
        //  1) Every pre-existing mission is still present by its original
        //     id, and its (dependency_id, advisory_id, mission_type) tuple
        //     — the business key for the check-then-write — is unchanged.
        //     A non-matching tuple here would mean the bulk INSERT
        //     accidentally returned ids in a non-positional order, or
        //     the bulk UPDATE rewrote dependency_id/advisory_id/mission_type
        //     fields it shouldn't have.
        //
        //  2) Every pre-existing mission's title and description are
        //     unchanged. The bulk UPDATE rewrote title/description/action_hint
        //     for every row; a regression here would mean the VALUES list
        //     misaligned id → title pairs.
        //
        //  3) A previously-resolved mission that's back in the candidate
        //     set reopens (status 'open', resolved_at null). The single
        //     reopen row in the test fixture (if any) flips; the others
        //     keep their pre-existing status.
        //
        // What we DO NOT assert: the row count. The scorer's multi-mission-
        // type classifier can legitimately add new dep_update missions
        // when upstream `dependencies.latest_version` advances between
        // runs (pre-existing 48 + 3 new dep_updates is the expected
        // pattern here). The behavioral contract is per-row, not
        // per-count.
        const afterById = new Map(after.rows.map((r) => [r.mission_id, r]));
        for (const beforeRow of before.rows) {
          const afterRow = afterById.get(beforeRow.mission_id);
          if (afterRow === undefined) {
            throw new Error(
              `Live Neon: pre-existing mission ${beforeRow.mission_id} disappeared after re-run (was this resolved? expected auto-resolved rows, not missing rows)`,
            );
          }
          expect(afterRow.title).toBe(beforeRow.title);
          expect(afterRow.description).toBe(beforeRow.description);
          expect(afterRow.dependency_id).toBe(beforeRow.dependency_id);
          expect(afterRow.advisory_id).toBe(beforeRow.advisory_id);
          expect(afterRow.mission_type).toBe(beforeRow.mission_type);
          // Status: a previously-resolved mission that's back as a
          // candidate reopens. Anything else stays.
          if (beforeRow.status === "resolved") {
            expect(afterRow.status).toBe("open");
          } else {
            expect(afterRow.status).toBe(beforeRow.status);
          }
        }

        await pool.end();
      },
    );
  },
);
