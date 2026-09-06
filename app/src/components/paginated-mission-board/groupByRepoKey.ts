import type { MissionWithScore } from "@deptend/core";

export interface MissionGroup {
  repoKey: string;
  missions: MissionWithScore[];
}

export function repoKeyOf(mission: MissionWithScore): string {
  return `${mission.repo.owner}/${mission.repo.name}`;
}

export function groupByRepoKey(missions: readonly MissionWithScore[]): MissionGroup[] {
  const order: string[] = [];
  const groups = new Map<string, MissionWithScore[]>();
  for (const mission of missions) {
    const key = repoKeyOf(mission);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [mission]);
      order.push(key);
    } else {
      existing.push(mission);
    }
  }
  return order.map((repoKey) => ({ repoKey, missions: groups.get(repoKey) ?? [] }));
}
