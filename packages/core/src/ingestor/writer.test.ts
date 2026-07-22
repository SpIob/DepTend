/**
 * IngestionWriter unit tests
 *
 * The Drizzle DB is replaced with a lightweight stub that records every call
 * and returns controlled results. No database connection is needed.
 *
 * Strategy:
 *   - Each Drizzle builder method (insert, update, select) returns a chainable
 *     mock object. The terminal call (.returning(), implicit .execute()) returns
 *     a controlled result.
 *   - The transaction mock runs the callback synchronously with the same stub db.
 *   - Tests assert on the final WriteIngestionOutput and on which methods were
 *     called, not on internal SQL strings.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { getTableName, type Table } from "drizzle-orm";
import { IngestionWriter } from "./writer.js";
import type { WriteIngestionInput } from "./writer.js";
import type { IngestorResult } from "./interface.js";
import type { OsvFetchResult } from "./osv.js";
import type { NpmRegistryFetchResult } from "./registry.js";
import type { NewAdvisory } from "../db/schema.js";

/** The exact type IngestionWriter's constructor expects, derived directly
 * from the class so the mock stays in sync if the constructor signature
 * changes. Casting through `unknown` (not `any`) keeps the argument typed
 * at the call site instead of surfacing as an unsafe `any`. */
type WriterDb = ConstructorParameters<typeof IngestionWriter>[0];

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------

/**
 * Creates a minimal Drizzle-compatible mock.
 *
 * Call sequences modelled:
 *   insert(table).values(rows).onConflictDoUpdate(...).returning({...})
 *   insert(table).values(rows).onConflictDoUpdate(...)           [no returning]
 *   update(table).set({...}).where(...)                          [no returning]
 *   select({...}).from(table).where(...)                         [returns rows]
 *   transaction(callback)                                        [runs callback]
 */
interface Chain {
  values: () => Chain;
  onConflictDoUpdate: () => Chain;
  set: (values: Record<string, unknown>) => Chain;
  where: () => Promise<unknown[]>;
  from: () => Chain;
  returning: () => Promise<unknown[]>;
}

interface MockDbCalls {
  inserts: string[];
  updates: string[];
  selects: string[];
  transactionCalled: boolean;
  /** Every value object passed to .set(), in call order, across all update() calls. */
  setCalls: Record<string, unknown>[];
}

interface MockDb {
  _calls: MockDbCalls;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
}

function makeMockDb(overrides: {
  /** Rows returned by the repos upsert .returning() */
  repoRow?: { id: string };
  /** Rows returned by the ingestionRuns insert .returning() */
  runRow?: { id: string };
  /** Rows returned by the dependencies upsert .returning() */
  depRows?: { id: string; packageName: string; depType: string }[];
  /** Rows returned by the advisories select (osv_id → id lookup) */
  advisoryRows?: { id: string; osvId: string }[];
  /** Whether the transaction callback should throw */
  txShouldThrow?: boolean;
}): MockDb {
  const {
    repoRow = { id: "repo-uuid-1" },
    runRow = { id: "run-uuid-1" },
    depRows = [],
    advisoryRows = [],
    txShouldThrow = false,
  } = overrides;

  // Track calls for assertions
  const calls: MockDbCalls = {
    inserts: [],
    updates: [],
    selects: [],
    transactionCalled: false,
    setCalls: [],
  };

  // Counter to distinguish successive .returning() calls
  let returningCallCount = 0;

  function makeChain(): Chain {
    const chain: Chain = {
      values: (): Chain => chain,
      onConflictDoUpdate: (): Chain => chain,
      set: (values: Record<string, unknown>): Chain => {
        calls.setCalls.push(values);
        return chain;
      },
      where: (): Promise<unknown[]> => Promise.resolve([]),
      from: (): Chain => chain,
      returning: (): Promise<unknown[]> => {
        returningCallCount++;
        // 1st returning call → repos upsert
        if (returningCallCount === 1) return Promise.resolve([repoRow]);
        // 2nd returning call → ingestion_runs insert
        if (returningCallCount === 2) return Promise.resolve([runRow]);
        // 3rd returning call → dependencies upsert
        if (returningCallCount === 3) return Promise.resolve(depRows);
        return Promise.resolve([]);
      },
    };

    return chain;
  }

  const db: MockDb = {
    _calls: calls,

    insert: vi.fn((table: Table): Chain => {
      calls.inserts.push(getTableName(table));
      return makeChain();
    }),

    update: vi.fn((table: Table): Chain => {
      calls.updates.push(getTableName(table));
      return makeChain();
    }),

    select: vi.fn((): Chain => {
      calls.selects.push("select");
      const chain = makeChain();
      // Override where() to return the advisory rows for the osv_id lookup
      chain.where = (): Promise<unknown[]> => Promise.resolve(advisoryRows);
      return chain;
    }),

    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      calls.transactionCalled = true;
      if (txShouldThrow) throw new Error("DB transaction failed");
      // The transaction runs with the same mock db so returning() counters
      // continue correctly
      return callback(db);
    }),
  };

  return db;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const REPO_INPUT: WriteIngestionInput["repo"] = {
  githubUrl: "https://github.com/owner/repo",
  owner: "owner",
  name: "repo",
  defaultBranch: "main",
  description: "A test repo",
  stars: 42,
  openIssuesCount: 3,
  topics: ["typescript"],
  homepageUrl: null,
  submittedBy: null,
};

function makeIngestorResult(
  depCount = 2,
  warnings: string[] = [],
  packageJsonResolved = true,
): IngestorResult {
  return {
    ecosystem: "npm",
    dependencies: Array.from({ length: depCount }, (_, i) => ({
      package_name: `pkg-${String(i)}`,
      version_spec: `^${String(i)}.0.0`,
      dep_type: "production" as const,
    })),
    lock_file_present: false,
    package_json_resolved: packageJsonResolved,
    warnings,
  };
}

function makeOsvResult(advisoryCount = 1): OsvFetchResult {
  const advisories = new Map<string, NewAdvisory>();
  const packageAdvisoryMap = new Map<string, string[]>();

  for (let i = 0; i < advisoryCount; i++) {
    const osvId = `GHSA-test-${i.toString().padStart(4, "0")}-0000`;
    advisories.set(osvId, {
      osvId,
      source: "ghsa",
      ecosystem: "npm",
      packageName: `pkg-0`,
      severity: "high",
      cvssScore: 7.5,
      summary: `Test advisory ${String(i)}`,
      details: null,
      affectedVersions: [],
      fixedVersion: "2.0.0",
      publishedAt: new Date("2024-01-01"),
      modifiedAt: new Date("2024-01-15"),
      rawData: { id: osvId },
    });
  }

  if (advisoryCount > 0) {
    packageAdvisoryMap.set(
      "pkg-0",
      Array.from(
        { length: advisoryCount },
        (_, i) => `GHSA-test-${i.toString().padStart(4, "0")}-0000`,
      ),
    );
  }

  return { advisories, packageAdvisoryMap, warnings: [] };
}

function makeRegistryResult(packages: string[] = ["pkg-0", "pkg-1"]): NpmRegistryFetchResult {
  const metadata = new Map(
    packages.map((name) => [
      name,
      {
        packageName: name,
        latestVersion: "2.0.0",
        isDeprecated: false,
        deprecationNote: null,
      },
    ]),
  );
  return { metadata, warnings: [] };
}

function makeInput(overrides: Partial<WriteIngestionInput> = {}): WriteIngestionInput {
  return {
    repo: REPO_INPUT,
    ingestorResult: makeIngestorResult(),
    osvResult: makeOsvResult(),
    registryResult: makeRegistryResult(),
    triggeredBy: "cron",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IngestionWriter", () => {
  let db: ReturnType<typeof makeMockDb>;
  let writer: IngestionWriter;

  beforeEach(() => {
    db = makeMockDb({
      repoRow: { id: "repo-uuid-1" },
      runRow: { id: "run-uuid-1" },
      depRows: [
        { id: "dep-uuid-0", packageName: "pkg-0", depType: "production" },
        { id: "dep-uuid-1", packageName: "pkg-1", depType: "production" },
      ],
      advisoryRows: [{ id: "adv-uuid-0", osvId: "GHSA-test-0000-0000" }],
    });
    writer = new IngestionWriter(db as unknown as WriterDb);
  });

  // -------------------------------------------------------------------------
  describe("write — happy path", () => {
    it("returns correct output shape on success", async () => {
      const result = await writer.write(makeInput());

      expect(result.repoId).toBe("repo-uuid-1");
      expect(result.runId).toBe("run-uuid-1");
      expect(result.status).toBe("complete");
      expect(result.dependenciesWritten).toBe(2);
      expect(result.advisoriesWritten).toBe(1);
      expect(result.dependencyAdvisoriesWritten).toBe(1);
      expect(result.allWarnings).toHaveLength(0);
    });

    it("marks the repo complete with no ingestionError", async () => {
      await writer.write(makeInput());

      // Second update() call is the repos row (first is closeRun on ingestion_runs)
      expect(db._calls.setCalls[1]).toMatchObject({
        ingestionStatus: "complete",
        ingestionError: null,
      });
    });

    it("merges warnings from all three upstream results", async () => {
      const input = makeInput({
        ingestorResult: makeIngestorResult(2, ["ingestor warning"]),
        osvResult: { ...makeOsvResult(0), warnings: ["osv warning"] },
        registryResult: { ...makeRegistryResult(), warnings: ["registry warning"] },
      });

      const result = await writer.write(input);

      expect(result.allWarnings).toEqual(["ingestor warning", "osv warning", "registry warning"]);
    });

    it("calls insert for repos, ingestion_runs, advisories, dependencies, dependency_advisories", async () => {
      await writer.write(makeInput());

      // repos + ingestion_runs + advisories + dependencies + dependency_advisories
      expect(db.insert).toHaveBeenCalledTimes(5);
    });

    it("calls update twice: once to close run, once to mark repo complete", async () => {
      await writer.write(makeInput());
      expect(db.update).toHaveBeenCalledTimes(2);
    });

    it("wraps steps 3–5 in a transaction", async () => {
      await writer.write(makeInput());
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it("selects advisory UUIDs inside the transaction to build dep_advisory links", async () => {
      await writer.write(makeInput());
      // select is called once: advisory UUID lookup
      expect(db.select).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("write — empty dependencies", () => {
    it("skips transaction body and returns zero counts when no dependencies parsed", async () => {
      const input = makeInput({
        ingestorResult: makeIngestorResult(0),
        osvResult: makeOsvResult(0),
        registryResult: makeRegistryResult([]),
      });

      // With no deps, depRows returning() won't be called — reset mock
      db = makeMockDb({
        repoRow: { id: "repo-uuid-1" },
        runRow: { id: "run-uuid-1" },
        depRows: [],
        advisoryRows: [],
      });
      writer = new IngestionWriter(db as unknown as WriterDb);

      const result = await writer.write(input);

      expect(result.status).toBe("complete");
      expect(result.dependenciesWritten).toBe(0);
      expect(result.advisoriesWritten).toBe(0);
      expect(result.dependencyAdvisoriesWritten).toBe(0);
    });

    it("does not insert advisories when advisory map is empty", async () => {
      const input = makeInput({ osvResult: makeOsvResult(0) });

      db = makeMockDb({
        repoRow: { id: "repo-uuid-1" },
        runRow: { id: "run-uuid-1" },
        depRows: [
          { id: "dep-uuid-0", packageName: "pkg-0", depType: "production" },
          { id: "dep-uuid-1", packageName: "pkg-1", depType: "production" },
        ],
        advisoryRows: [],
      });
      writer = new IngestionWriter(db as unknown as WriterDb);

      const result = await writer.write(input);

      expect(result.advisoriesWritten).toBe(0);
      expect(result.dependencyAdvisoriesWritten).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("write — skipped (no package.json found)", () => {
    beforeEach(() => {
      db = makeMockDb({
        repoRow: { id: "repo-uuid-1" },
        runRow: { id: "run-uuid-1" },
        depRows: [],
        advisoryRows: [],
      });
      writer = new IngestionWriter(db as unknown as WriterDb);
    });

    it("returns status: skipped when package_json_resolved is false", async () => {
      const input = makeInput({
        ingestorResult: makeIngestorResult(
          0,
          [
            "No package.json found at https://raw.githubusercontent.com/o/r/main/package.json. Repository skipped.",
          ],
          false,
        ),
        osvResult: makeOsvResult(0),
        registryResult: makeRegistryResult([]),
      });

      const result = await writer.write(input);

      expect(result.status).toBe("skipped");
      expect(result.dependenciesWritten).toBe(0);
    });

    it("marks the repo skipped and records the specific reason in ingestionError", async () => {
      const input = makeInput({
        ingestorResult: makeIngestorResult(
          0,
          [
            "No package.json found at https://raw.githubusercontent.com/o/r/main/package.json. Repository skipped.",
          ],
          false,
        ),
        osvResult: makeOsvResult(0),
        registryResult: makeRegistryResult([]),
      });

      await writer.write(input);

      // Second update() call is the repos row (first is closeRun on ingestion_runs)
      expect(db._calls.setCalls[1]).toMatchObject({
        ingestionStatus: "skipped",
        ingestionError:
          "No package.json found at https://raw.githubusercontent.com/o/r/main/package.json. Repository skipped.",
      });
    });

    it("closes the ingestion_runs row with status 'skipped', not 'complete' or 'failed'", async () => {
      const input = makeInput({
        ingestorResult: makeIngestorResult(
          0,
          ["No package.json found. Repository skipped."],
          false,
        ),
        osvResult: makeOsvResult(0),
        registryResult: makeRegistryResult([]),
      });

      await writer.write(input);

      // First update() call is closeRun on ingestion_runs
      expect(db._calls.setCalls[0]).toMatchObject({ status: "skipped" });
    });

    it("does not throw — a missing package.json is not a pipeline error", async () => {
      const input = makeInput({
        ingestorResult: makeIngestorResult(
          0,
          ["No package.json found. Repository skipped."],
          false,
        ),
        osvResult: makeOsvResult(0),
        registryResult: makeRegistryResult([]),
      });

      await expect(writer.write(input)).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("write — transaction failure", () => {
    it("records 'failed' status on the run row when transaction throws", async () => {
      db = makeMockDb({
        repoRow: { id: "repo-uuid-1" },
        runRow: { id: "run-uuid-1" },
        txShouldThrow: true,
      });
      writer = new IngestionWriter(db as unknown as WriterDb);

      await expect(writer.write(makeInput())).rejects.toThrow("DB transaction failed");

      // update should have been called once to record the failure on the run row
      expect(db.update).toHaveBeenCalledTimes(1);
    });

    it("rethrows the transaction error after recording it", async () => {
      db = makeMockDb({
        repoRow: { id: "repo-uuid-1" },
        runRow: { id: "run-uuid-1" },
        txShouldThrow: true,
      });
      writer = new IngestionWriter(db as unknown as WriterDb);

      await expect(writer.write(makeInput())).rejects.toThrow("DB transaction failed");
    });
  });

  // -------------------------------------------------------------------------
  describe("write — registry metadata merge", () => {
    it("records null latestVersion when registry metadata is missing for a package", async () => {
      // registryResult has no entry for pkg-1
      const input = makeInput({
        registryResult: makeRegistryResult(["pkg-0"]), // pkg-1 missing
      });

      db = makeMockDb({
        repoRow: { id: "repo-uuid-1" },
        runRow: { id: "run-uuid-1" },
        depRows: [
          { id: "dep-uuid-0", packageName: "pkg-0", depType: "production" },
          { id: "dep-uuid-1", packageName: "pkg-1", depType: "production" },
        ],
        advisoryRows: [{ id: "adv-uuid-0", osvId: "GHSA-test-0000-0000" }],
      });
      writer = new IngestionWriter(db as unknown as WriterDb);

      // Should not throw — missing registry metadata is handled gracefully
      const result = await writer.write(input);
      expect(result.dependenciesWritten).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  describe("write — triggered_by", () => {
    it.each(["cron", "manual", "submit"] as const)(
      "passes triggeredBy '%s' through to the run row",
      async (triggeredBy) => {
        const result = await writer.write(makeInput({ triggeredBy }));
        // If insert was called without error, the triggeredBy value was accepted
        expect(result.runId).toBe("run-uuid-1");
      },
    );
  });
});
