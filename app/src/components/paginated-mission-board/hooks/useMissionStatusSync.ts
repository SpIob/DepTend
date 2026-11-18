"use client";

import { useState } from "react";
import type { MissionWithScore } from "@deptend/core";
import type { MissionPatch } from "../../mission-card/types";

export function useMissionStatusSync(
  initialMissions: MissionWithScore[],
): [MissionWithScore[], (missionId: string, patch: MissionPatch) => void, () => void] {
  const [missions, setMissions] = useState(initialMissions);

  function handleStatusChange(missionId: string, patch: MissionPatch): void {
    setMissions((prev) => prev.map((m) => (m.id === missionId ? { ...m, ...patch } : m)));
  }

  function resetMissions(): void {
    setMissions(initialMissions);
  }

  return [missions, handleStatusChange, resetMissions];
}
