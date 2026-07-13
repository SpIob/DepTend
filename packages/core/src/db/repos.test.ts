/**
 * repos.ts unit tests
 *
 * Two things under test: parseGithubUrl() (pure, extensive input-shape
 * coverage) and submitRepo() (mocked DB — same chainable-stub strategy as
 * scorer/writer.test.ts and ingestor/writer.test.ts, sized down to this
 * file's actual call shape: at most three select() calls in a fixed
 * order — existence check, cap count, optional race recheck — and one
 * insert().values().onConflictDoNothing().returning()).
 *
 * submitRepo's count query (`db.select({count}).from(repos)`) is awaited
 * directly with no .where()/.limit() — unlike the existence/race-recheck
 * queries, which chain .where().limit(1). The mock's .from() has to be
 * thenable on its own for this reason, not just after .where().
 */

import { describe, expect, it, vi } from "vitest";
import { parseGithubUrl, submitRepo, type SubmitRepoParams } from "./repos.js";
import type { Repo } from "./schema.js";

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
  /** Responses for each select() call, consumed in the order submitRepo makes them. */
  selectResponses: unknown[][];
  /** Rows returned by insert().returning() — empty array simulates onConflictDoNothing firing. */
  insertResponse: unknown[];
}

function makeMockDb(options: MockDbOptions): {
  db: SubmitRepoDb;
  insertedValues: Record<string, unknown>[];
} {
  let selectIndex = 0;
  const insertedValues: Record<string, unknown>[] = [];

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const rows = options.selectResponses[selectIndex] ?? [];
        selectIndex++;
        return fromResult(rows);
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        insertedValues.push(v);
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve(options.insertResponse)),
          })),
        };
      }),
    })),
  };

  return { db: db as unknown as SubmitRepoDb, insertedValues };
}

type SubmitRepoDb = Parameters<typeof submitRepo>[0];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRepoRow(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo-1",
    githubUrl: "https://github.com/example/example",
    owner: "example",
    name: "example",
    defaultBranch: "main",
    description: null,
    stars: 0,
    openIssuesCount: 0,
    topics: [],
    homepageUrl: null,
    ingestionStatus: "pending",
    lastIngestedAt: null,
    ingestionError: null,
    submittedBy: "octocat",
    createdAt: new Date("2026-07-11"),
    updatedAt: new Date("2026-07-11"),
    ...overrides,
  };
}

const BASE_PARAMS: SubmitRepoParams = {
  githubUrl: "https://github.com/example/example",
  owner: "example",
  name: "example",
  submittedBy: "octocat",
  maxRepos: 3,
};

// ---------------------------------------------------------------------------
// parseGithubUrl
// ---------------------------------------------------------------------------

describe("parseGithubUrl", () => {
  it.each([
    "https://github.com/owner/repo",
    "http://github.com/owner/repo",
    "github.com/owner/repo",
    "https://www.github.com/owner/repo",
    "https://github.com/owner/repo/",
    "https://github.com/owner/repo.git",
    "www.github.com/owner/repo.git/",
  ])("accepts %s and normalizes it to https://github.com/owner/repo", (input) => {
    expect(parseGithubUrl(input)).toEqual({
      githubUrl: "https://github.com/owner/repo",
      owner: "owner",
      name: "repo",
    });
  });

  it("trims leading/trailing whitespace before parsing", () => {
    expect(parseGithubUrl("  https://github.com/owner/repo  ")).toEqual({
      githubUrl: "https://github.com/owner/repo",
      owner: "owner",
      name: "repo",
    });
  });

  it("accepts owner/repo names with hyphens, underscores, dots, and digits", () => {
    expect(parseGithubUrl("https://github.com/my-org2/my_repo.js")).toEqual({
      githubUrl: "https://github.com/my-org2/my_repo.js",
      owner: "my-org2",
      name: "my_repo.js",
    });
  });

  it("accepts single-character owner and repo names", () => {
    expect(parseGithubUrl("https://github.com/a/b")).toEqual({
      githubUrl: "https://github.com/a/b",
      owner: "a",
      name: "b",
    });
  });

  it.each([
    ["https://gitlab.com/owner/repo", "non-GitHub host (gitlab.com)"],
    ["https://bitbucket.org/owner/repo", "non-GitHub host (bitbucket.org)"],
    [
      "https://raw.githubusercontent.com/owner/repo/main/x",
      "GitHub subdomain, not github.com itself",
    ],
    ["https://github.com/owner", "missing repo name"],
    ["https://github.com/", "missing owner and repo"],
    ["", "empty string"],
    ["   ", "whitespace only"],
    ["not a url at all", "garbage input"],
    ["https://github.com/-owner/repo", "owner starting with a hyphen"],
    ["https://github.com/owner-/repo", "owner ending with a hyphen"],
  ])("rejects %s (%s)", (input) => {
    expect(parseGithubUrl(input)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// submitRepo
// ---------------------------------------------------------------------------

describe("submitRepo", () => {
  it("returns created when the repo is new and under the cap", async () => {
    const insertedRow = makeRepoRow();
    const { db, insertedValues } = makeMockDb({
      selectResponses: [[], [{ count: 1 }]], // existence check empty, count = 1
      insertResponse: [insertedRow],
    });

    const result = await submitRepo(db, BASE_PARAMS);

    expect(result).toEqual({ outcome: "created", repo: insertedRow });
    expect(insertedValues).toEqual([
      {
        githubUrl: BASE_PARAMS.githubUrl,
        owner: BASE_PARAMS.owner,
        name: BASE_PARAMS.name,
        submittedBy: BASE_PARAMS.submittedBy,
      },
    ]);
  });

  it("returns already_exists without checking the cap or inserting when the repo is already submitted", async () => {
    const existingRow = makeRepoRow({ id: "existing-repo" });
    const { db } = makeMockDb({
      selectResponses: [[existingRow]], // existence check finds a row
      insertResponse: [],
    });
    const insertSpy = vi.spyOn(db, "insert");

    const result = await submitRepo(db, BASE_PARAMS);

    expect(result).toEqual({ outcome: "already_exists", repo: existingRow });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("returns cap_reached when the repo is new but the count has reached maxRepos", async () => {
    const { db, insertedValues } = makeMockDb({
      selectResponses: [[], [{ count: 3 }]], // existence check empty, count = maxRepos
      insertResponse: [],
    });

    const result = await submitRepo(db, { ...BASE_PARAMS, maxRepos: 3 });

    expect(result).toEqual({ outcome: "cap_reached", repo: null });
    expect(insertedValues).toHaveLength(0);
  });

  it("allows the submission that exactly fills the last slot (count = maxRepos - 1)", async () => {
    const insertedRow = makeRepoRow();
    const { db } = makeMockDb({
      selectResponses: [[], [{ count: 2 }]], // one slot remaining under a cap of 3
      insertResponse: [insertedRow],
    });

    const result = await submitRepo(db, { ...BASE_PARAMS, maxRepos: 3 });

    expect(result.outcome).toBe("created");
  });

  it("treats a lost same-URL race (onConflictDoNothing fires) as already_exists", async () => {
    const raceWinnerRow = makeRepoRow({ id: "race-winner" });
    const { db } = makeMockDb({
      // existence check empty, count under cap, then the post-insert
      // recheck (insert itself returns []) finds the row a concurrent
      // request just created.
      selectResponses: [[], [{ count: 1 }], [raceWinnerRow]],
      insertResponse: [], // onConflictDoNothing hit — nothing returned
    });

    const result = await submitRepo(db, BASE_PARAMS);

    expect(result).toEqual({ outcome: "already_exists", repo: raceWinnerRow });
  });

  it("returns already_exists with a null repo if the race recheck itself comes back empty", async () => {
    // Pathological (shouldn't happen in practice — something else deleted
    // the row between the conflict and the recheck), but the function
    // must not throw or return an inconsistent shape.
    const { db } = makeMockDb({
      selectResponses: [[], [{ count: 1 }], []],
      insertResponse: [],
    });

    const result = await submitRepo(db, BASE_PARAMS);

    expect(result).toEqual({ outcome: "already_exists", repo: null });
  });

  it("treats a missing count row as zero rather than throwing", async () => {
    const insertedRow = makeRepoRow();
    const { db } = makeMockDb({
      selectResponses: [[], []], // count query returns no rows at all
      insertResponse: [insertedRow],
    });

    const result = await submitRepo(db, BASE_PARAMS);

    expect(result.outcome).toBe("created");
  });
});
