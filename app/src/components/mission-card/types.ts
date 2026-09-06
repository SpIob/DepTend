import type { MissionStatus, MissionType, ScoreConfidence } from "@deptend/core/db/schema.js";

export type { MissionStatus, MissionType, ScoreConfidence };

/** What changes on a mission after a successful claim/unclaim call. */
export interface MissionClaimPatch {
  status: MissionStatus;
  claimedBy: string | null;
  claimedAt: Date | null;
}

export type ClaimRequestState =
  { kind: "idle" } | { kind: "pending" } | { kind: "error"; message: string };

/**
 * The six states a mission can be in for the action UI. Computed from
 * `status` + `claimedBy` + the current viewer's `login` so the render
 * below is a pure switch on `mode` — the "exhaustive switches, no
 * silent defaults" pattern the AGENTS.md §7 rule calls out as the
 * codebase convention.
 */
export type MissionActionMode =
  | "open-claimable"
  | "open-signed-out"
  | "claimed-by-me"
  | "claimed-by-other"
  | "dismissed-by-me"
  | "dismissed-signed-out";
