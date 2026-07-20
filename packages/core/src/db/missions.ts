/**
 * Mission claim / unclaim
 *
 * Lives here, not in /app, for the same reason repos.ts and queries.ts do
 * (see queries.ts's header) — keeps every Drizzle query against schema.ts
 * in one program/project context, avoiding the cross-package type-identity
 * issue from ADR 0012.
 *
 * Each operation is a single guarded UPDATE...WHERE, not a transaction —
 * same reasoning as submitRepo() in repos.ts: neon-http doesn't support
 * db.transaction() (ADR 0009), but a single conditional UPDATE is already
 * atomic on its own, so no transaction is needed here. The WHERE clause
 * (status must currently be "open" to claim, or "claimed" + claimedBy must
 * match to unclaim) is what prevents a double-claim or an unclaim by
 * someone other than the claimant — a lost race just means the loser's
 * UPDATE matches zero rows, which is distinguished from "mission doesn't
 * exist" by a follow-up SELECT.
 */

import { and, eq } from "drizzle-orm";
import { missions } from "./schema.js";
import type { ReadonlyDb } from "./queries.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shape-only validation for a mission ID before it reaches a guarded
 * update — same role parseGithubUrl() plays for repos.ts. Without this, a
 * malformed ID (e.g. a stray route param) reaches Postgres as a raw
 * "invalid input syntax for type uuid" error instead of a clean 400 at
 * the API route.
 */
export function isValidMissionId(id: string): boolean {
  return UUID_PATTERN.test(id);
}

export type ClaimMissionOutcome = "claimed" | "already_claimed" | "not_found";

/**
 * Claims an open mission on behalf of claimedBy (a GitHub login). Only
 * succeeds if the mission is currently "open" — already-claimed, resolved,
 * or dismissed missions are left untouched.
 */
export async function claimMission(
  db: ReadonlyDb,
  missionId: string,
  claimedBy: string,
): Promise<ClaimMissionOutcome> {
  const [updated] = await db
    .update(missions)
    .set({ status: "claimed", claimedBy, claimedAt: new Date() })
    .where(and(eq(missions.id, missionId), eq(missions.status, "open")))
    .returning({ id: missions.id });

  if (updated !== undefined) {
    return "claimed";
  }

  const [existing] = await db
    .select({ id: missions.id })
    .from(missions)
    .where(eq(missions.id, missionId))
    .limit(1);

  return existing === undefined ? "not_found" : "already_claimed";
}

export type UnclaimMissionOutcome = "unclaimed" | "not_claimed_by_you" | "not_found";

/**
 * Releases a mission claimed by requestingUser back to "open". Only
 * succeeds if the mission is currently "claimed" by that exact user —
 * covers both "claimed by someone else" and "not currently claimed at
 * all" (open/resolved/dismissed) under the same not_claimed_by_you
 * outcome, since the caller's remedy is the same either way: nothing to
 * unclaim on their behalf.
 */
export async function unclaimMission(
  db: ReadonlyDb,
  missionId: string,
  requestingUser: string,
): Promise<UnclaimMissionOutcome> {
  const [updated] = await db
    .update(missions)
    .set({ status: "open", claimedBy: null, claimedAt: null })
    .where(
      and(
        eq(missions.id, missionId),
        eq(missions.status, "claimed"),
        eq(missions.claimedBy, requestingUser),
      ),
    )
    .returning({ id: missions.id });

  if (updated !== undefined) {
    return "unclaimed";
  }

  const [existing] = await db
    .select({ id: missions.id })
    .from(missions)
    .where(eq(missions.id, missionId))
    .limit(1);

  return existing === undefined ? "not_found" : "not_claimed_by_you";
}
