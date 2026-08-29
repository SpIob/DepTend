/**
 * reviveDates + cachedRead unit tests (ADR 0033's Date revival)
 *
 * unstable_cache serializes through JSON, so cached reads return ISO
 * strings where Dates were typed. reviveDates revives them by the "*At"
 * key-suffix convention every timestamp column here follows — but only when
 * the string actually IS an ISO timestamp, so a corrupted or non-date
 * "*At"-suffixed string passes through instead of becoming an Invalid Date.
 *
 * The cachedRead tests pin WHERE revival runs: outside unstable_cache's
 * wrapped callback. The original ADR 0033 placement (revival inside the
 * callback) is useless in production — unstable_cache serializes the
 * callback's return into the store before the caller sees it — and took /
 * down live with `lastIngestedAt.toLocaleDateString is not a function`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getIndexedRepoCount,
  getRepoDirectorySummary,
  getSkippedRepos,
  getTotalRepoCount,
  getReposWithMissionSummary,
  reviveDates,
} from "./missions";

const unstableCache = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ unstable_cache: unstableCache }));

const getRepoDirectoryBase = vi.hoisted(() => vi.fn());
const coreGetRepoDirectorySummary = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/queries.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRepoDirectoryBase,
  getRepoDirectorySummary: coreGetRepoDirectorySummary,
}));

const getDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ getDb }));

/**
 * Simulates what production's data cache does to a read result even on a
 * miss: serialize the wrapped callback's return value into the store and
 * hand back the parsed copy. Any Date the callback returns arrives here as
 * an ISO string — which is exactly why revival must happen after cached()
 * returns, not inside it.
 */
function serializingCache(fn: unknown): () => Promise<unknown> {
  return async (): Promise<unknown> => {
    const value = await (fn as () => Promise<unknown>)();
    return JSON.parse(JSON.stringify(value)) as unknown;
  };
}

describe("reviveDates", () => {
  it("converts an ISO '*At' string into a real Date", () => {
    const revived = reviveDates({ publishedAt: "2026-08-23T12:34:56.789Z" });
    expect(revived.publishedAt).toEqual(new Date("2026-08-23T12:34:56.789Z"));
    expect(revived.publishedAt).toBeInstanceOf(Date);
  });

  it("accepts offset-form ISO timestamps, not just Z", () => {
    const revived = reviveDates({ claimedAt: "2026-08-23T12:34:56+02:00" });
    expect(revived.claimedAt).toBeInstanceOf(Date);
  });

  it("passes live Date instances through unchanged (the cache-miss path)", () => {
    const date = new Date("2026-08-23T12:34:56.789Z");
    const revived = reviveDates({ publishedAt: date });
    expect(revived.publishedAt).toBe(date);
  });

  it("leaves a non-date '*At' string alone instead of creating an Invalid Date", () => {
    // The corruption-class guard: new Date("garbage") would silently yield
    // Invalid Date; this must pass the string through untouched.
    const revived = reviveDates({ updatedAt: "garbage" });
    expect(revived.updatedAt).toBe("garbage");
  });

  it("leaves a partial-timestamp '*At' string alone (e.g. a bare date)", () => {
    const revived = reviveDates({ resolvedAt: "2026-08-23" });
    expect(revived.resolvedAt).toBe("2026-08-23");
  });

  it("never touches non-'*At' string fields, even full ISO timestamps", () => {
    const revived = reviveDates({
      summary: "2026-08-23T12:34:56.789Z",
      osvId: "GHSA-xxxx-yyyy-zzzz",
    });
    expect(revived.summary).toBe("2026-08-23T12:34:56.789Z");
    expect(typeof revived.summary).toBe("string");
  });

  it("recurses into nested objects and arrays (rawData-style jsonb blobs)", () => {
    const revived = reviveDates({
      modifiedAt: "2026-08-23T00:00:00Z",
      nested: [{ createdAt: "2026-08-22T00:00:00Z", keep: "as-string" }],
    });
    expect(revived.modifiedAt).toBeInstanceOf(Date);
    expect(revived.nested[0]?.createdAt).toBeInstanceOf(Date);
    expect(revived.nested[0]?.keep).toBe("as-string");
  });

  it("returns primitives unchanged", () => {
    expect(reviveDates(42)).toBe(42);
    expect(reviveDates(null)).toBe(null);
  });
});

describe("cachedRead revival placement", () => {
  const FIXTURE_ROW = {
    id: "r-1",
    owner: "octocat",
    name: "hello-world",
    lastIngestedAt: new Date("2026-08-23T12:00:00.000Z"),
    createdAt: new Date("2026-08-01T09:00:00.000Z"),
    isBookmarked: false,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    unstableCache.mockImplementation(serializingCache);
    getRepoDirectoryBase.mockResolvedValue([FIXTURE_ROW]);
  });

  it("hands the caller real Dates even though the cache layer serialized them", async () => {
    const rows = await getReposWithMissionSummary();

    expect(rows[0]?.lastIngestedAt).toBeInstanceOf(Date);
    expect(rows[0]?.lastIngestedAt).toEqual(FIXTURE_ROW.lastIngestedAt);
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("wraps the raw read in unstable_cache — revival is not part of the stored callback", async () => {
    await getReposWithMissionSummary();

    expect(unstableCache).toHaveBeenCalledTimes(1);
    const [cachedFn, keyParts, options] = unstableCache.mock.calls[0] as unknown as [
      unknown,
      string[],
      { revalidate: number; tags: string[] },
    ];
    // The stored callback returns the driver's own value; if revival moved
    // back inside it, the serialization fake above would make this test's
    // sibling fail — this assertion documents the intended split directly.
    expect(typeof cachedFn).toBe("function");
    expect(keyParts).toEqual(["repo-directory-base"]);
    expect(options).toEqual({ revalidate: 60, tags: ["repos"] });
  });

  it("bypasses the cache entirely for a signed-in caller — per-user overlay must never share a cache key with another user", async () => {
    getDb.mockReturnValue({ __signedInDb: true });
    await getReposWithMissionSummary("octocat");

    expect(unstableCache).not.toHaveBeenCalled();
    // The signed-in path delegates straight to core's getRepoDirectoryBase,
    // which returns the merged isBookmarked + isSubscribed flags in one
    // trip (PR 1, item 1.3). The db handle is whatever getDb() returned.
    expect(getRepoDirectoryBase).toHaveBeenCalledWith(
      { __signedInDb: true },
      { userLogin: "octocat" },
    );
  });
});

describe("getRepoDirectorySummary cached read (ADR 0046)", () => {
  const SUMMARY_FIXTURE = {
    indexedCount: 7,
    totalCount: 12,
    skippedRepos: [{ owner: "octo", name: "no-manifest", reason: "No package.json found" }],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    unstableCache.mockImplementation(serializingCache);
    coreGetRepoDirectorySummary.mockResolvedValue(SUMMARY_FIXTURE);
  });

  it("shares one cache slot for the three header-chrome consumers", async () => {
    // Three call sites — getIndexedRepoCount, getTotalRepoCount, and
    // getSkippedRepos — now share a single cached read. The cache key is
    // the load-bearing contract: with the same key, a real unstable_cache
    // would de-dupe the three lookups; with three different keys, the
    // cache would be three independent slots and revalidateTag("repos")
    // would have to invalidate all three. We assert the key here rather
    // than the call count, because the test's mock unstable_cache
    // intentionally doesn't de-dupe by key (see serializingCache above) —
    // so a per-call count assertion would test the mock, not the contract.
    await getIndexedRepoCount();
    await getTotalRepoCount();
    await getSkippedRepos();

    // Every call into unstable_cache used the same key + tag — that's the
    // one-slot invariant. Three calls is fine; three different keys is
    // not.
    expect(unstableCache).toHaveBeenCalledTimes(3);
    for (const call of unstableCache.mock.calls) {
      const [, keyParts, options] = call as [
        unknown,
        string[],
        { revalidate: number; tags: string[] },
      ];
      expect(keyParts).toEqual(["repo-directory-summary"]);
      expect(options).toEqual({ revalidate: 60, tags: ["repos"] });
    }
  });

  it("wraps the summary read in unstable_cache with the documented key/tag/TTL", async () => {
    await getRepoDirectorySummary();

    const [cachedFn, keyParts, options] = unstableCache.mock.calls[0] as unknown as [
      unknown,
      string[],
      { revalidate: number; tags: string[] },
    ];
    expect(typeof cachedFn).toBe("function");
    // One cache key, one tag — replacing the three independent
    // cachedRead slots (indexed-repo-count / total-repo-count /
    // skipped-repos) that pre-ADR-0046 pages consumed in parallel.
    expect(keyParts).toEqual(["repo-directory-summary"]);
    expect(options).toEqual({ revalidate: 60, tags: ["repos"] });
  });

  it("derives each accessor from the shared cached summary", async () => {
    expect(await getIndexedRepoCount()).toBe(7);
    expect(await getTotalRepoCount()).toBe(12);
    expect(await getSkippedRepos()).toEqual(SUMMARY_FIXTURE.skippedRepos);
  });
});
