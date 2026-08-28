/**
 * Mission list queries — thin wrappers around @deptend/core's
 * getBoardMissionsWithScoresPage/getIndexedRepoCount/getTotalRepoCount,
 * bound to /app's own db client. See packages/core/src/db/queries.ts for
 * why the actual Drizzle query logic lives there instead of here.
 *
 * Read caching (ADR 0033): the shared, slowly-changing reads go through
 * unstable_cache with a 60-second TTL and two invalidation tags —
 * "missions" and "repos". The mutating API routes revalidate those tags on
 * success, so claims and bookmarks stay immediately fresh; only
 * ingestion-driven changes (written by the external Actions cron, which
 * can't call revalidateTag) wait out the TTL. Per-user reads (bookmarks)
 * are never cached. Pages keep force-dynamic — this caches at the query
 * layer, not the page.
 */

import { unstable_cache } from "next/cache";
import { getBookmarkedRepoIds as coreGetBookmarkedRepoIds } from "@deptend/core/db/bookmarks.js";
import {
  BOARD_PAGE_SIZE,
  getBoardMissionsWithScoresPage as coreGetBoardMissionsWithScoresPage,
  getIndexedRepoCount as coreGetIndexedRepoCount,
  getRepoEcosystems as coreGetRepoEcosystems,
  getRepoDirectoryBase as coreGetRepoDirectoryBase,
  getRepoMissionsWithScores as coreGetRepoMissionsWithScores,
  getSkippedRepos as coreGetSkippedRepos,
  getTotalRepoCount as coreGetTotalRepoCount,
  type BoardFilters,
  type BoardPage,
  type SkippedRepo,
} from "@deptend/core/db/queries.js";
import { getRepoByOwnerAndName as coreGetRepoByOwnerAndName } from "@deptend/core/db/repos.js";
import type { Ecosystem, MissionWithScore, Repo, RepoWithMissionSummary } from "@deptend/core";
import { getDb } from "../db";

export type { BoardFilters, BoardPage };
export { BOARD_PAGE_SIZE };

/** How stale ingestion-driven reads may get (ADR 0033 — chosen by Mico). */
const READ_CACHE_SECONDS = 60;

/**
 * unstable_cache serializes through JSON, so on a cache hit every Date
 * comes back as an ISO string. Every timestamp column in this schema is
 * named `*At`, so reviving by key suffix restores real Date instances —
 * which components render and core's rankMissions() calls .getTime() on —
 * without hand-listing fields. Runs on the miss path too, where it's a
 * no-op pass-through for live Date objects.
 *
 * Exported for unit testing (same convention as osv.ts's pure utilities).
 */
export function reviveDates<T>(value: T): T {
  return reviveValue(value) as T;
}

/**
 * Matches exactly what a Postgres timestamptz column serializes to over
 * JSON — an ISO 8601 timestamp ("2026-08-23T12:34:56.789Z", offset form
 * included). The suffix check alone isn't enough: new Date("garbage")
 * silently yields Invalid Date, and jsonb blobs (rawData, scoring inputs)
 * can legally carry non-date "*At"-suffixed keys. A string that fails this
 * shape passes through untouched instead of being corrupted.
 */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** Recursion core over `unknown` — typed-linting safe, no `any` leakage. */
function reviveValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => reviveValue(item));
  }
  const revived: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    revived[key] =
      typeof field === "string" && key.endsWith("At") && ISO_TIMESTAMP_RE.test(field)
        ? new Date(field)
        : reviveValue(field);
  }
  return revived;
}

/** Build a deterministic cache key from BoardFilters — arrays are sorted to ensure consistent ordering. */
function boardFiltersCacheKey(filters: BoardFilters): string {
  return JSON.stringify({
    q: filters.q,
    severities: [...filters.severities].sort(),
    ecosystems: [...filters.ecosystems].sort(),
    efforts: [...filters.efforts].sort(),
    missionTypes: [...filters.missionTypes].sort(),
    sort: filters.sort,
  });
}

/** unstable_cache wrapper for one cached read: fixed key parts + tag + TTL.
 *
 * reviveDates runs on the RESULT of cached() — outside unstable_cache —
 * deliberately. Inside the wrapped callback its output would be
 * JSON-serialized into the store before the caller ever saw it, so every
 * served value (miss AND hit) arrives as "*At" ISO strings and Date-typed
 * consumers crash (found live: repo-card's toLocaleDateString took down /
 * in production with exactly that placement). Outside, the miss path gets
 * live Dates from the driver and passes through unchanged, and the hit
 * path gets real Dates revived from their stored ISO strings. */
function cachedRead<T>(
  keyParts: string[],
  tag: "missions" | "repos",
  read: () => Promise<T>,
): Promise<T> {
  const cached = unstable_cache(read, keyParts, {
    revalidate: READ_CACHE_SECONDS,
    tags: [tag],
  });
  return cached().then(reviveDates);
}

/**
 * One page of the board-wide listing (ADR 0031) — filters and sort applied
 * server-side, page selected by 1-based `page` against BOARD_PAGE_SIZE.
 * Cached under the "missions" tag (ADR 0033).
 */
export function getBoardMissionsPage(filters: BoardFilters, page: number): Promise<BoardPage> {
  return cachedRead(["board-page", boardFiltersCacheKey(filters), String(page)], "missions", () =>
    coreGetBoardMissionsWithScoresPage(getDb(), filters, {
      limit: BOARD_PAGE_SIZE,
      offset: (page - 1) * BOARD_PAGE_SIZE,
    }),
  );
}

export function getIndexedRepoCount(): Promise<number> {
  return cachedRead(["indexed-repo-count"], "repos", () => coreGetIndexedRepoCount(getDb()));
}

export function getTotalRepoCount(): Promise<number> {
  return cachedRead(["total-repo-count"], "repos", () => coreGetTotalRepoCount(getDb()));
}

export function getSkippedRepos(): Promise<SkippedRepo[]> {
  return cachedRead(["skipped-repos"], "repos", () => coreGetSkippedRepos(getDb()));
}

/**
 * Repo directory rows (ADR 0027) — the login-independent base is cached
 * under the "repos" tag; the viewer's bookmark flags are overlaid fresh on
 * every request, so toggling a bookmark never waits on the cache (ADR 0033).
 */
export async function getReposWithMissionSummary(
  userLogin?: string,
): Promise<RepoWithMissionSummary[]> {
  const repos = await cachedRead(["repo-directory-base"], "repos", () =>
    coreGetRepoDirectoryBase(getDb()),
  );
  if (userLogin === undefined) {
    return repos;
  }
  const bookmarkedRepoIds = await coreGetBookmarkedRepoIds(getDb(), userLogin);
  return repos.map((repo) =>
    bookmarkedRepoIds.has(repo.id) ? { ...repo, isBookmarked: true } : repo,
  );
}

/** Open + claimed missions for one repo — the /repo/[owner]/[name] page's query (ADR 0027). Cached under the "missions" tag (ADR 0033). */
export function getRepoMissionsWithScores(repoId: string): Promise<MissionWithScore[]> {
  return cachedRead(["repo-missions", repoId], "missions", () =>
    coreGetRepoMissionsWithScores(getDb(), repoId),
  );
}

/** Resolves /repo/[owner]/[name]'s route params to a repo row, or null for a 404 (ADR 0027). Uncached — cheap unique-index lookup. */
export async function getRepoByOwnerAndName(owner: string, name: string): Promise<Repo | null> {
  return coreGetRepoByOwnerAndName(getDb(), owner, name);
}

/** Repo IDs bookmarked by userLogin — backs the repo detail page's bookmark toggle (ADR 0027). Uncached by design (see ADR 0033). */
export async function getBookmarkedRepoIds(userLogin: string): Promise<Set<string>> {
  return coreGetBookmarkedRepoIds(getDb(), userLogin);
}

/** Ecosystems present in one repo — backs the repo detail page's badge row. Uncached — cheap indexed lookup. */
export async function getRepoEcosystems(repoId: string): Promise<Ecosystem[]> {
  return coreGetRepoEcosystems(getDb(), repoId);
}
