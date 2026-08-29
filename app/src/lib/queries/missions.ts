/**
 * Mission list queries — thin wrappers around @deptend/core's
 * getBoardMissionsWithScoresPage/getIndexedRepoCount/getTotalRepoCount,
 * bound to /app's own db client. See packages/core/src/db/queries.ts for
 * why the actual Drizzle query logic lives there instead of here.
 *
 * Read caching (ADR 0033): the shared, slowly-changing reads go through
 * the shared `cachedRead` wrapper (see ./cached-read.ts), with a 60-second
 * TTL and two invalidation tags — "missions" and "repos". The mutating API
 * routes revalidate those tags on success, so claims and bookmarks stay
 * immediately fresh; only ingestion-driven changes (written by the
 * external Actions cron, which can't call revalidateTag) wait out the TTL.
 * Per-user reads (bookmarks) are never cached. Pages keep force-dynamic —
 * this caches at the query layer, not the page.
 */

import { cachedRead, reviveDates } from "./cached-read";
import { getBookmarkedRepoIds as coreGetBookmarkedRepoIds } from "@deptend/core/db/bookmarks.js";
import {
  BOARD_PAGE_SIZE,
  getBoardMissionsWithScoresPage as coreGetBoardMissionsWithScoresPage,
  getIndexedRepoCount as coreGetIndexedRepoCount,
  getRepoBoardPage as coreGetRepoBoardPage,
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

/** Re-export for back-compat with existing imports in /app and tests. */
export { reviveDates };

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
 * under the "repos" tag; the viewer's bookmark + subscription flags are
 * applied by core's getRepoDirectoryBase({ userLogin }), so the per-user
 * overlay never serves from cache and toggling a bookmark never waits on
 * the cache (ADR 0033).
 *
 * Two distinct code paths for two distinct cache-key spaces: an anonymous
 * call gets a cached read (no per-user data to protect), a signed-in
 * call bypasses the cache entirely (per-user overlay must not leak
 * between users via a shared cache key).
 */
export function getReposWithMissionSummary(userLogin?: string): Promise<RepoWithMissionSummary[]> {
  if (userLogin === undefined) {
    return cachedRead(["repo-directory-base"], "repos", () =>
      coreGetRepoDirectoryBase(getDb(), {}),
    );
  }
  return coreGetRepoDirectoryBase(getDb(), { userLogin });
}

/** Open + claimed missions for one repo — the /repo/[owner]/[name] page's query (ADR 0027). Cached under the "missions" tag (ADR 0033). */
export function getRepoMissionsWithScores(repoId: string): Promise<MissionWithScore[]> {
  return cachedRead(["repo-missions", repoId], "missions", () =>
    coreGetRepoMissionsWithScores(getDb(), repoId),
  );
}

/**
 * Per-repo BoardPage (ADR 0042). Same shape PaginatedMissionBoard
 * consumes on /missions, but scoped to one repo. The per-repo page calls
 * this with pageSize = missions.length and pageCount = 1 to suppress
 * pagination, and the per-repo URL does not carry a `page` field, so the
 * cache key omits it. The result is always "all matching rows for this
 * repo" because pagination never actually paginates here. Filters still
 * need to be in the key because the page's chip clicks do navigate.
 */
export function getRepoBoardPage(repoId: string, filters: BoardFilters): Promise<BoardPage> {
  return cachedRead(["repo-board-page", repoId, boardFiltersCacheKey(filters)], "missions", () =>
    coreGetRepoBoardPage(getDb(), repoId, filters),
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
