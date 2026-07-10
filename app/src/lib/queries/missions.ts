/**
 * Mission list queries — thin wrapper around @deptend/core's
 * getOpenMissionsWithScores/getIndexedRepoCount/getTotalRepoCount, bound
 * to /app's own db client. See packages/core/src/db/queries.ts for why
 * the actual Drizzle query logic lives there instead of here.
 */

import {
  getIndexedRepoCount as coreGetIndexedRepoCount,
  getOpenMissionsWithScores,
  getTotalRepoCount as coreGetTotalRepoCount,
} from "@deptend/core/db/queries.js";
import type { MissionWithScore } from "@deptend/core";
import { getDb } from "../db";

export async function getOpenMissions(): Promise<MissionWithScore[]> {
  return getOpenMissionsWithScores(getDb());
}

export async function getIndexedRepoCount(): Promise<number> {
  return coreGetIndexedRepoCount(getDb());
}

export async function getTotalRepoCount(): Promise<number> {
  return coreGetTotalRepoCount(getDb());
}
