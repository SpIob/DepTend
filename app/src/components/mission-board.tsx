"use client";

import { useState } from "react";
import type { EffortLabel, Severity } from "@deptend/core/db/schema.js";
import type { MissionWithScore } from "@deptend/core";
import { MissionCard, type MissionClaimPatch } from "./mission-card";
import { MissionFilterBar } from "./mission-filter-bar";

function EmptyFilterState(): React.JSX.Element {
  return (
    <div className="border-border bg-surface rounded-sm border border-dashed p-10 text-center">
      <p className="text-ink font-medium">No missions match these filters.</p>
      <p className="text-ink-muted mt-1 text-sm">Try clearing one or more filters above.</p>
    </div>
  );
}

export function MissionBoard({
  missions: initialMissions,
}: {
  missions: MissionWithScore[];
}): React.JSX.Element {
  const [missions, setMissions] = useState(initialMissions);
  const [selectedSeverities, setSelectedSeverities] = useState<ReadonlySet<Severity>>(new Set());
  const [selectedEfforts, setSelectedEfforts] = useState<ReadonlySet<EffortLabel>>(new Set());

  function toggleSeverity(severity: Severity): void {
    setSelectedSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(severity)) {
        next.delete(severity);
      } else {
        next.add(severity);
      }
      return next;
    });
  }

  function toggleEffort(effort: EffortLabel): void {
    setSelectedEfforts((prev) => {
      const next = new Set(prev);
      if (next.has(effort)) {
        next.delete(effort);
      } else {
        next.add(effort);
      }
      return next;
    });
  }

  function clearFilters(): void {
    setSelectedSeverities(new Set());
    setSelectedEfforts(new Set());
  }

  function handleStatusChange(missionId: string, patch: MissionClaimPatch): void {
    setMissions((prev) => prev.map((m) => (m.id === missionId ? { ...m, ...patch } : m)));
  }

  const filtered = missions.filter((mission) => {
    const severity = mission.advisory?.severity ?? "unknown";
    if (selectedSeverities.size > 0 && !selectedSeverities.has(severity)) {
      return false;
    }
    if (selectedEfforts.size > 0 && !selectedEfforts.has(mission.score.effortLabel)) {
      return false;
    }
    return true;
  });

  const isFiltered = selectedSeverities.size > 0 || selectedEfforts.size > 0;

  return (
    <div className="flex flex-col gap-5">
      <MissionFilterBar
        selectedSeverities={selectedSeverities}
        onToggleSeverity={toggleSeverity}
        selectedEfforts={selectedEfforts}
        onToggleEffort={toggleEffort}
        onClear={clearFilters}
      />

      {isFiltered && (
        <p className="text-ink-muted font-mono text-xs">
          {filtered.length} of {missions.length} missions
        </p>
      )}

      {filtered.length === 0 ? (
        <EmptyFilterState />
      ) : (
        <ul className="flex flex-col gap-4">
          {filtered.map((mission) => (
            <li key={mission.id}>
              <MissionCard mission={mission} onStatusChange={handleStatusChange} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
