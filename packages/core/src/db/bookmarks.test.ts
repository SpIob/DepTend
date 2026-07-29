/**
 * bookmarks.ts unit tests
 *
 * Same chainable-stub mocking strategy as missions.test.ts and
 * repos.test.ts, sized to this file's three call shapes: a guarded
 * select().from().where().limit(1) existence check + insert().values()
 * .onConflictDoNothing().returning() for bookmarkRepo(); a single
 * delete().where().returning() for unbookmarkRepo(); and a plain
 * select().from().where() (no limit — every matching row is wanted) for
 * getBookmarkedRepoIds().
 */

import { describe, expect, it, vi } from "vitest";
import { bookmarkRepo, getBookmarkedRepoIds, unbookmarkRepo } from "./bookmarks.js";

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
  /** Responses for each select() call, consumed in the order the function under test makes them. */
  selectResponses?: unknown[][];
  /** Rows returned by insert().onConflictDoNothing().returning() — empty simulates the conflict clause firing. */
  insertResponse?: unknown[];
  /** Rows returned by delete().returning() — empty simulates no matching row. */
  deleteResponse?: unknown[];
}

type BookmarksDb = Parameters<typeof bookmarkRepo>[0];

function makeMockDb(options: MockDbOptions): {
  db: BookmarksDb;
  insertedValues: Record<string, unknown>[];
} {
  let selectIndex = 0;
  const insertedValues: Record<string, unknown>[] = [];

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const rows = (options.selectResponses ?? [])[selectIndex] ?? [];
        selectIndex++;
        return fromResult(rows);
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        insertedValues.push(v);
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve(options.insertResponse ?? [])),
          })),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve(options.deleteResponse ?? [])),
      })),
    })),
  };

  return { db: db as unknown as BookmarksDb, insertedValues };
}

// ---------------------------------------------------------------------------
// bookmarkRepo
// ---------------------------------------------------------------------------

describe("bookmarkRepo", () => {
  it("returns not_found without inserting when the repo doesn't exist", async () => {
    const { db, insertedValues } = makeMockDb({ selectResponses: [[]] });
    const insertSpy = vi.spyOn(db, "insert");

    const result = await bookmarkRepo(db, "repo-1", "octocat");

    expect(result).toBe("not_found");
    expect(insertSpy).not.toHaveBeenCalled();
    expect(insertedValues).toHaveLength(0);
  });

  it("returns bookmarked and inserts repoId/userLogin when the repo exists", async () => {
    const { db, insertedValues } = makeMockDb({
      selectResponses: [[{ id: "repo-1" }]],
      insertResponse: [{ id: "bookmark-1" }],
    });

    const result = await bookmarkRepo(db, "repo-1", "octocat");

    expect(result).toBe("bookmarked");
    expect(insertedValues).toEqual([{ repoId: "repo-1", userLogin: "octocat" }]);
  });

  it("returns already_bookmarked when onConflictDoNothing fires", async () => {
    const { db } = makeMockDb({
      selectResponses: [[{ id: "repo-1" }]],
      insertResponse: [],
    });

    const result = await bookmarkRepo(db, "repo-1", "octocat");

    expect(result).toBe("already_bookmarked");
  });
});

// ---------------------------------------------------------------------------
// unbookmarkRepo
// ---------------------------------------------------------------------------

describe("unbookmarkRepo", () => {
  it("returns unbookmarked when a matching bookmark is deleted", async () => {
    const { db } = makeMockDb({ deleteResponse: [{ id: "bookmark-1" }] });

    const result = await unbookmarkRepo(db, "repo-1", "octocat");

    expect(result).toBe("unbookmarked");
  });

  it("returns not_bookmarked when nothing matches (never bookmarked, someone else's bookmark, or repo doesn't exist)", async () => {
    const { db } = makeMockDb({ deleteResponse: [] });

    const result = await unbookmarkRepo(db, "repo-1", "octocat");

    expect(result).toBe("not_bookmarked");
  });
});

// ---------------------------------------------------------------------------
// getBookmarkedRepoIds
// ---------------------------------------------------------------------------

describe("getBookmarkedRepoIds", () => {
  it("returns a Set of the bookmarked repo IDs", async () => {
    const { db } = makeMockDb({
      selectResponses: [[{ repoId: "repo-1" }, { repoId: "repo-2" }]],
    });

    const result = await getBookmarkedRepoIds(db, "octocat");

    expect(result).toEqual(new Set(["repo-1", "repo-2"]));
  });

  it("returns an empty Set when the user has no bookmarks", async () => {
    const { db } = makeMockDb({ selectResponses: [[]] });

    const result = await getBookmarkedRepoIds(db, "octocat");

    expect(result).toEqual(new Set());
  });
});
