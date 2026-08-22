/**
 * Mission list queries — thin wrappers around @deptend/core's
 * getBoardMissionsWithScoresPage/getIndexedRepoCount/getTotalRepoCount,
 * bound to /app's own db client. See packages/core/src/db/queries.ts for
 * why the actual Drizzle query logic lives there instead of here.
 */

import { getBookmarkedRepoIds as coreGetBookmarkedRepoIds } from "@deptend/core/db/bookmarks.js";
import {
  BOARD_PAGE_SIZE,
  getBoardMissionsWithScoresPage as coreGetBoardMissionsWithScoresPage,
  getIndexedRepoCount as coreGetIndexedRepoCount,
  getRepoEcosystems as coreGetRepoEcosystems,
  getRepoMissionsWithScores as coreGetRepoMissionsWithScores,
  getReposWithMissionSummary as coreGetReposWithMissionSummary,
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

/**
 * One page of the board-wide listing (ADR 0031) — filters and sort applied
 * server-side, page selected by 1-based `page` against BOARD_PAGE_SIZE.
 */
export async function getBoardMissionsPage(
  filters: BoardFilters,
  page: number,
): Promise<BoardPage> {
  return coreGetBoardMissionsWithScoresPage(getDb(), filters, {
    limit: BOARD_PAGE_SIZE,
    offset: (page - 1) * BOARD_PAGE_SIZE,
  });
}

export async function getIndexedRepoCount(): Promise<number> {
  return coreGetIndexedRepoCount(getDb());
}

export async function getTotalRepoCount(): Promise<number> {
  return coreGetTotalRepoCount(getDb());
}

export async function getSkippedRepos(): Promise<SkippedRepo[]> {
  return coreGetSkippedRepos(getDb());
}

/** Repo directory rows (ADR 0027) — pass the signed-in user's login to populate isBookmarked. */
export async function getReposWithMissionSummary(
  userLogin?: string,
): Promise<RepoWithMissionSummary[]> {
  return coreGetReposWithMissionSummary(getDb(), userLogin);
}

/** Open + claimed missions for one repo — the /repo/[owner]/[name] page's query (ADR 0027). */
export async function getRepoMissionsWithScores(repoId: string): Promise<MissionWithScore[]> {
  return coreGetRepoMissionsWithScores(getDb(), repoId);
}

/** Resolves /repo/[owner]/[name]'s route params to a repo row, or null for a 404 (ADR 0027). */
export async function getRepoByOwnerAndName(owner: string, name: string): Promise<Repo | null> {
  return coreGetRepoByOwnerAndName(getDb(), owner, name);
}

/** Repo IDs bookmarked by userLogin — backs the repo detail page's bookmark toggle (ADR 0027). */
export async function getBookmarkedRepoIds(userLogin: string): Promise<Set<string>> {
  return coreGetBookmarkedRepoIds(getDb(), userLogin);
}

/** Ecosystems present in one repo — backs the repo detail page's badge row. */
export async function getRepoEcosystems(repoId: string): Promise<Ecosystem[]> {
  return coreGetRepoEcosystems(getDb(), repoId);
}
