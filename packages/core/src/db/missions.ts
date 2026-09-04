/**
 * Mission claim / unclaim / dismiss / undismiss
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

export type DismissMissionOutcome = "dismissed" | "not_open" | "not_found";

/**
 * Dismisses an open mission ("won't fix / not applicable") with an
 * optional human-readable reason. Only open missions can be dismissed:
 * a claimed mission belongs to its claimant (unclaim it first), and
 * resolved/dismissed are already terminal for board purposes — those
 * collapse under one not_open outcome since the caller's remedy is
 * identical: nothing to dismiss.
 *
 * Like claim/unclaim above: a single guarded UPDATE whose WHERE clause is
 * the concurrency control; the follow-up SELECT only distinguishes
 * not_found from not_open. No requestingUser parameter because nothing
 * about the dismisser is stamped on the row (schema has no dismissed_by;
 * dismissed_at + dismiss_reason carry the record) — authorization happens
 * at the route's session gate, same as claiming.
 */
export async function dismissMission(
  db: ReadonlyDb,
  missionId: string,
  reason?: string | null,
): Promise<DismissMissionOutcome> {
  const [updated] = await db
    .update(missions)
    .set({
      status: "dismissed",
      dismissedAt: new Date(),
      ...(reason != null && reason !== "" && { dismissReason: reason }),
    })
    .where(and(eq(missions.id, missionId), eq(missions.status, "open")))
    .returning({ id: missions.id });

  if (updated !== undefined) {
    return "dismissed";
  }

  const [existing] = await db
    .select({ id: missions.id })
    .from(missions)
    .where(eq(missions.id, missionId))
    .limit(1);

  return existing === undefined ? "not_found" : "not_open";
}

export type UndismissMissionOutcome = "restored" | "not_dismissed" | "not_found";

/**
 * Puts a dismissed mission back to "open", clearing the dismissal stamp.
 * Lossless by construction: only open missions can be dismissed, so a
 * dismissed mission never carries claim state that restoring would need
 * to preserve. Resolved missions are deliberately not restorable here —
 * reopening those is the pipeline's own decision (the pair reappearing in
 * a future run), not a UI action.
 */
export async function undismissMission(
  db: ReadonlyDb,
  missionId: string,
): Promise<UndismissMissionOutcome> {
  const [updated] = await db
    .update(missions)
    .set({
      status: "open",
      dismissedAt: null,
      dismissReason: null,
    })
    .where(and(eq(missions.id, missionId), eq(missions.status, "dismissed")))
    .returning({ id: missions.id });

  if (updated !== undefined) {
    return "restored";
  }

  const [existing] = await db
    .select({ id: missions.id })
    .from(missions)
    .where(eq(missions.id, missionId))
    .limit(1);

  return existing === undefined ? "not_found" : "not_dismissed";
}
