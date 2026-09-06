"use client";

import type { MissionWithScore } from "@deptend/core";
import type { BoardFilters } from "@deptend/core/db/queries.js";
import type { SortMode } from "@/lib/mission-board-query";
import type { Severity, Ecosystem, EffortLabel, MissionType } from "@deptend/core/db/schema.js";

export function getSeverity(mission: MissionWithScore): Severity {
  return (mission.advisory?.severity ?? "unknown") as Severity;
}

export function getEcosystem(mission: MissionWithScore): Ecosystem {
  return (mission.advisory?.ecosystem ?? mission.dependency?.ecosystem ?? "unknown") as Ecosystem;
}

export function getEffortLabel(mission: MissionWithScore): EffortLabel {
  return (mission.score?.effortLabel ?? "unknown") as EffortLabel;
}

export function getMissionType(mission: MissionWithScore): MissionType {
  return mission.missionType;
}

export function getPackageName(mission: MissionWithScore): string {
  return mission.dependency?.packageName ?? "";
}

export function getRepoOwner(mission: MissionWithScore): string {
  return mission.repo?.owner ?? "";
}

export function getRepoName(mission: MissionWithScore): string {
  return mission.repo?.name ?? "";
}

export function getAdvisoryId(mission: MissionWithScore): string {
  return mission.advisory?.osvId ?? "";
}

export function getCompositeScore(mission: MissionWithScore): number {
  return mission.score?.compositeScore ?? 0;
}

export function getAdvisoryPublishedAt(mission: MissionWithScore): Date | null {
  return mission.advisory?.publishedAt ?? null;
}

export function filterMissions(
  missions: MissionWithScore[],
  filters: BoardFilters,
): MissionWithScore[] {
  return missions.filter((mission) => {
    if (filters.severities.length > 0 && !filters.severities.includes(getSeverity(mission))) {
      return false;
    }
    if (filters.ecosystems.length > 0 && !filters.ecosystems.includes(getEcosystem(mission))) {
      return false;
    }
    if (filters.efforts.length > 0 && !filters.efforts.includes(getEffortLabel(mission))) {
      return false;
    }
    if (
      filters.missionTypes.length > 0 &&
      !filters.missionTypes.includes(getMissionType(mission))
    ) {
      return false;
    }
    if (filters.q.trim() !== "") {
      const query = filters.q.toLowerCase();
      const searchable = [
        getPackageName(mission),
        getRepoOwner(mission),
        getRepoName(mission),
        getAdvisoryId(mission),
        mission.title,
      ]
        .join(" ")
        .toLowerCase();
      if (!searchable.includes(query)) {
        return false;
      }
    }
    return true;
  });
}

export function sortMissions(missions: MissionWithScore[], sort: SortMode): MissionWithScore[] {
  const sorted = [...missions];
  switch (sort) {
    case "priority":
      sorted.sort((a, b) => getCompositeScore(b) - getCompositeScore(a));
      break;
    case "quick-wins":
      sorted.sort((a, b) => {
        const effortOrder: Record<string, number> = { trivial: 0, low: 1, medium: 2, high: 3 };
        const aEffort = effortOrder[getEffortLabel(a)] ?? 4;
        const bEffort = effortOrder[getEffortLabel(b)] ?? 4;
        if (aEffort !== bEffort) return aEffort - bEffort;
        return getCompositeScore(b) - getCompositeScore(a);
      });
      break;
    case "newest":
      sorted.sort((a, b) => {
        const aTime = getAdvisoryPublishedAt(a)?.getTime() ?? 0;
        const bTime = getAdvisoryPublishedAt(b)?.getTime() ?? 0;
        return bTime - aTime;
      });
      break;
  }
  return sorted;
}

export function applyFiltersAndSort(
  missions: MissionWithScore[],
  filters: BoardFilters,
  sort: SortMode,
): MissionWithScore[] {
  const filtered = filterMissions(missions, filters);
  return sortMissions(filtered, sort);
}

export function computeFacets(missions: MissionWithScore[]): {
  severity: Record<string, number>;
  ecosystem: Record<string, number>;
  effort: Record<string, number>;
  missionType: Record<string, number>;
} {
  const severity: Record<string, number> = {};
  const ecosystem: Record<string, number> = {};
  const effort: Record<string, number> = {};
  const missionType: Record<string, number> = {};

  for (const mission of missions) {
    severity[getSeverity(mission)] = (severity[getSeverity(mission)] ?? 0) + 1;
    ecosystem[getEcosystem(mission)] = (ecosystem[getEcosystem(mission)] ?? 0) + 1;
    effort[getEffortLabel(mission)] = (effort[getEffortLabel(mission)] ?? 0) + 1;
    missionType[getMissionType(mission)] = (missionType[getMissionType(mission)] ?? 0) + 1;
  }

  return { severity, ecosystem, effort, missionType };
}
