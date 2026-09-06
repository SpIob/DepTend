import type { MissionWithScore } from "@deptend/core";
import type { MissionClaimPatch } from "./types";

interface MissionCardProps {
  mission: MissionWithScore;
  onStatusChange?: ((missionId: string, patch: MissionClaimPatch) => void) | undefined;
}

export function areMissionsEqual(prev: MissionCardProps, next: MissionCardProps): boolean {
  if (prev.mission.id !== next.mission.id) return false;
  if (prev.mission.status !== next.mission.status) return false;
  if (prev.mission.claimedBy !== next.mission.claimedBy) return false;
  if (prev.mission.claimedAt?.getTime() !== next.mission.claimedAt?.getTime()) return false;
  if (prev.mission.score.compositeScore !== next.mission.score.compositeScore) return false;
  if (prev.mission.score.confidence !== next.mission.score.confidence) return false;
  return prev.onStatusChange === next.onStatusChange;
}
