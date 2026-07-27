"use client";

import { useState } from "react";
import type { Ecosystem, EffortLabel, Severity } from "@deptend/core/db/schema.js";
import type { MissionWithScore } from "@deptend/core";
import { MissionCard, type MissionClaimPatch } from "./mission-card";
import { MissionFilterBar } from "./mission-filter-bar";
import { MissionSearchInput } from "./mission-search";

function EmptyFilterState(): React.JSX.Element {
  return (
    <div className="border-border bg-surface rounded-sm border border-dashed p-10 text-center">
      <p className="text-ink font-medium">No missions match these filters.</p>
      <p className="text-ink-muted mt-1 text-sm">Try clearing or loosening a filter above.</p>
    </div>
  );
}

function severityOf(mission: MissionWithScore): Severity {
  return mission.advisory?.severity ?? "unknown";
}

// Dependency and advisory are both nullable on MissionWithScore; in practice
// vulnerability_fix missions always carry at least one, but this stays
// defensive rather than assuming it.
function ecosystemOf(mission: MissionWithScore): Ecosystem | null {
  return mission.dependency?.ecosystem ?? mission.advisory?.ecosystem ?? null;
}

function matchesSearch(mission: MissionWithScore, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  const haystack = [
    mission.title,
    mission.dependency?.packageName ?? "",
    `${mission.repo.owner}/${mission.repo.name}`,
    mission.advisory?.osvId ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

// `value` is typed `T | null` so this works uniformly for severity/effort
// (never actually null) and ecosystem (occasionally null) without needing a
// second, near-duplicate helper.
function matchesSet<T>(value: T | null, set: ReadonlySet<T>): boolean {
  if (set.size === 0) {
    return true;
  }
  return value !== null && set.has(value);
}

function countBy<T extends string>(
  items: readonly MissionWithScore[],
  keyOf: (mission: MissionWithScore) => T | null,
): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) {
      continue;
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function MissionBoard({
  missions: initialMissions,
}: {
  missions: MissionWithScore[];
}): React.JSX.Element {
  const [missions, setMissions] = useState(initialMissions);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSeverities, setSelectedSeverities] = useState<ReadonlySet<Severity>>(new Set());
  const [selectedEcosystems, setSelectedEcosystems] = useState<ReadonlySet<Ecosystem>>(new Set());
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

  function toggleEcosystem(ecosystem: Ecosystem): void {
    setSelectedEcosystems((prev) => {
      const next = new Set(prev);
      if (next.has(ecosystem)) {
        next.delete(ecosystem);
      } else {
        next.add(ecosystem);
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
    setSelectedEcosystems(new Set());
    setSelectedEfforts(new Set());
  }

  function handleStatusChange(missionId: string, patch: MissionClaimPatch): void {
    setMissions((prev) => prev.map((m) => (m.id === missionId ? { ...m, ...patch } : m)));
  }

  const searchMatched = missions.filter((mission) => matchesSearch(mission, searchQuery));

  // Each axis's chip counts are computed against every *other* active axis
  // (but not itself), so a count reflects "how many results if I also
  // picked this," not a static total that never moves.
  const severityCounts = countBy(
    searchMatched.filter(
      (mission) =>
        matchesSet(mission.score.effortLabel, selectedEfforts) &&
        matchesSet(ecosystemOf(mission), selectedEcosystems),
    ),
    severityOf,
  );
  const ecosystemCounts = countBy(
    searchMatched.filter(
      (mission) =>
        matchesSet(severityOf(mission), selectedSeverities) &&
        matchesSet(mission.score.effortLabel, selectedEfforts),
    ),
    ecosystemOf,
  );
  const effortCounts = countBy(
    searchMatched.filter(
      (mission) =>
        matchesSet(severityOf(mission), selectedSeverities) &&
        matchesSet(ecosystemOf(mission), selectedEcosystems),
    ),
    (mission) => mission.score.effortLabel,
  );

  const filtered = searchMatched.filter(
    (mission) =>
      matchesSet(severityOf(mission), selectedSeverities) &&
      matchesSet(ecosystemOf(mission), selectedEcosystems) &&
      matchesSet(mission.score.effortLabel, selectedEfforts),
  );

  const isFiltered =
    selectedSeverities.size > 0 ||
    selectedEcosystems.size > 0 ||
    selectedEfforts.size > 0 ||
    searchQuery.trim() !== "";

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-bg border-border sticky top-0 z-10 flex flex-col gap-3 border-b py-3">
        <MissionSearchInput value={searchQuery} onChange={setSearchQuery} />
        <MissionFilterBar
          selectedSeverities={selectedSeverities}
          onToggleSeverity={toggleSeverity}
          severityCounts={severityCounts}
          selectedEcosystems={selectedEcosystems}
          onToggleEcosystem={toggleEcosystem}
          ecosystemCounts={ecosystemCounts}
          selectedEfforts={selectedEfforts}
          onToggleEffort={toggleEffort}
          effortCounts={effortCounts}
          onClear={clearFilters}
        />
        {isFiltered && (
          <p className="text-ink-muted font-mono text-xs">
            {filtered.length} of {missions.length} missions
          </p>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyFilterState />
      ) : (
        <ul className="flex flex-col gap-3">
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
