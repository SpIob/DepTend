import type { MissionActionMode } from "./types";
import type { MissionStatus } from "@deptend/core/db/schema.js";

export function osvUrl(osvId: string): string {
  return `https://osv.dev/vulnerability/${encodeURIComponent(osvId)}`;
}

/**
 * Short-form OSV ID for at-a-glance disambiguation. Two advisories
 * against the same package at the same severity and the same fix
 * version produce the same `mission.title` (mission-copy.ts's
 * `buildTitle` is deterministic per (package, severity, missionType)).
 * The short prefix is the first two dash-separated chunks of the OSV
 * ID — enough to tell two rows apart at a glance without crowding
 * the title, and short enough to stay readable when wrapped or
 * truncated. Examples:
 *
 *   GHSA-x527-x647-q7gg  -> GHSA-x527
 *   CVE-2024-12345       -> CVE-2024
 *   PYSEC-2023-12345     -> PYSEC-2023
 *   GO-2024-1234         -> GO-2024
 *
 * Returns null for inputs that don't have a recognizable scheme or
 * are otherwise too short to chop, so the title render can fall back
 * to no suffix. See ADR 0051.
 */
export function shortOsvId(osvId: string): string | null {
  const parts = osvId.split("-");
  if (parts.length < 2) {
    return null;
  }
  return `${parts[0]?.toString() ?? ""}-${parts[1]?.toString() ?? ""}`;
}

export function computeMode(
  status: MissionStatus,
  claimedBy: string | null,
  login: string | undefined,
): MissionActionMode {
  if (status === "dismissed") {
    return login === undefined ? "dismissed-signed-out" : "dismissed-by-me";
  }
  if (status === "claimed") {
    if (claimedBy === login) {
      return "claimed-by-me";
    }
    return "claimed-by-other";
  }
  return login === undefined ? "open-signed-out" : "open-claimable";
}
