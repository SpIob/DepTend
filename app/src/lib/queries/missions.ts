/**
 * Mission list queries — thin wrapper around @deptend/core's
 * getOpenMissionsWithScores/getBoardMissionsWithScores/getIndexedRepoCount/
 * getTotalRepoCount, bound to /app's own db client. See
 * packages/core/src/db/queries.ts for why the actual Drizzle query logic
 * lives there instead of here.
 */

import {
  getBoardMissionsWithScores,
  getIndexedRepoCount as coreGetIndexedRepoCount,
  getOpenMissionsWithScores,
  getSkippedRepos as coreGetSkippedRepos,
  getTotalRepoCount as coreGetTotalRepoCount,
  type SkippedRepo,
} from "@deptend/core/db/queries.js";
import type { MissionWithScore } from "@deptend/core";
import { getDb } from "../db";

export async function getOpenMissions(): Promise<MissionWithScore[]> {
  return getOpenMissionsWithScores(getDb());
}

/** Open + claimed missions — what the Phase 5 public rescue board renders. */
export async function getBoardMissions(): Promise<MissionWithScore[]> {
  return getBoardMissionsWithScores(getDb());
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
