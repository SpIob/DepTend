"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import type { Ecosystem, EffortLabel, MissionType, Severity } from "@deptend/core/db/schema.js";
import type { MissionWithScore } from "@deptend/core";
import {
  parseSortParam,
  SORT_LABELS,
  SORT_MODES,
  type MissionBoardQuery,
  type SortMode,
} from "@/lib/mission-board-query";
import { MissionCardMemo as MissionCard, type MissionClaimPatch } from "./mission-card";
import { MissionFilterBar } from "./mission-filter-bar";
import { MissionSearchInput } from "./mission-search";

export type { MissionBoardQuery };

// Lower number sorts first under "quick-wins" — trivial fixes surface before
// high-effort ones.
const EFFORT_ORDER: Record<EffortLabel, number> = { trivial: 0, low: 1, medium: 2, high: 3 };

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

function repoKeyOf(mission: MissionWithScore): string {
  return `${mission.repo.owner}/${mission.repo.name}`;
}

/** The lowercase haystack a mission's search needle is matched against.
 * Built once per mission (memoized below), not once per keystroke. */
function haystackOf(mission: MissionWithScore): string {
  return [
    mission.title,
    mission.dependency?.packageName ?? "",
    repoKeyOf(mission),
    mission.advisory?.osvId ?? "",
  ]
    .join(" ")
    .toLowerCase();
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

function compareMissions(a: MissionWithScore, b: MissionWithScore, sortMode: SortMode): number {
  if (sortMode === "quick-wins") {
    const effortDiff = EFFORT_ORDER[a.score.effortLabel] - EFFORT_ORDER[b.score.effortLabel];
    if (effortDiff !== 0) {
      return effortDiff;
    }
    return b.score.compositeScore - a.score.compositeScore;
  }
  if (sortMode === "newest") {
    const aTime = a.advisory?.publishedAt?.getTime() ?? 0;
    const bTime = b.advisory?.publishedAt?.getTime() ?? 0;
    return bTime - aTime;
  }
  // "priority": preserve the server's own ranked order. Array#sort is a
  // stable sort, so returning 0 for every pair leaves it untouched.
  return 0;
}

interface MissionGroup {
  repoKey: string;
  missions: MissionWithScore[];
}

function groupByRepoKey(missions: readonly MissionWithScore[]): MissionGroup[] {
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

export function MissionBoard({
  missions: initialMissions,
  initialQuery,
  showGroupByRepo = true,
}: {
  missions: MissionWithScore[];
  initialQuery: MissionBoardQuery;
  /**
   * Hide the "Group by repo" checkbox — every mission on this board
   * already belongs to one repo, so grouping is a redundant, single-group
   * no-op (the per-repo page passes false). Forces the initial state off
   * too, not just the control, so a stray `?group=1` in the URL can't
   * bring back a grouping UI that isn't rendered anywhere.
   */
  showGroupByRepo?: boolean;
}): React.JSX.Element {
  const pathname = usePathname();

  const [missions, setMissions] = useState(initialMissions);
  const [searchQuery, setSearchQuery] = useState(initialQuery.q);
  const [selectedSeverities, setSelectedSeverities] = useState(initialQuery.severity);
  const [selectedEcosystems, setSelectedEcosystems] = useState(initialQuery.ecosystem);
  const [selectedEfforts, setSelectedEfforts] = useState(initialQuery.effort);
  const [selectedMissionTypes, setSelectedMissionTypes] = useState(initialQuery.missionType);
  const [sortMode, setSortMode] = useState(initialQuery.sort);
  const [groupByRepo, setGroupByRepo] = useState(showGroupByRepo && initialQuery.group);

  // Stabilize mission array reference: if initialMissions has the same mission IDs
  // and key fields as the current missions state, keep the existing reference.
  // This prevents unnecessary re-renders of memoized MissionCard components
  // when the server re-sends identical data.
  const stabilizedMissions = useMemo(() => {
    if (missions.length !== initialMissions.length) return initialMissions;
    for (let i = 0; i < missions.length; i++) {
      const a = missions[i];
      const b = initialMissions[i];
      if (!a || !b) return initialMissions;
      if (a.id !== b.id) return initialMissions;
      if (a.status !== b.status) return initialMissions;
      if (a.claimedBy !== b.claimedBy) return initialMissions;
      if (a.claimedAt?.getTime() !== b.claimedAt?.getTime()) return initialMissions;
      if (a.score.compositeScore !== b.score.compositeScore) return initialMissions;
      if (a.score.confidence !== b.score.confidence) return initialMissions;
    }
    return missions;
  }, [missions, initialMissions]);

  // Keeps the URL shareable/bookmarkable/refresh-safe. Deliberately
  // `window.history.replaceState` rather than next/navigation's router —
  // the router treats this as a navigation and would re-run the page's
  // server component (and its Neon queries) on every keystroke, which a
  // client-side-only filter/search/sort change has no reason to trigger.
  useEffect(() => {
    const params = new URLSearchParams();
    if (searchQuery.trim() !== "") {
      params.set("q", searchQuery.trim());
    }
    if (selectedSeverities.size > 0) {
      params.set("severity", Array.from(selectedSeverities).join(","));
    }
    if (selectedEcosystems.size > 0) {
      params.set("ecosystem", Array.from(selectedEcosystems).join(","));
    }
    if (selectedEfforts.size > 0) {
      params.set("effort", Array.from(selectedEfforts).join(","));
    }
    if (selectedMissionTypes.size > 0) {
      params.set("missionType", Array.from(selectedMissionTypes).join(","));
    }
    if (sortMode !== "priority") {
      params.set("sort", sortMode);
    }
    if (groupByRepo) {
      params.set("group", "1");
    }
    const query = params.toString();
    window.history.replaceState(null, "", query === "" ? pathname : `${pathname}?${query}`);
  }, [
    searchQuery,
    selectedSeverities,
    selectedEcosystems,
    selectedEfforts,
    selectedMissionTypes,
    sortMode,
    groupByRepo,
    pathname,
  ]);

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

  function toggleMissionType(type: MissionType): void {
    setSelectedMissionTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }

  function clearFilters(): void {
    setSelectedSeverities(new Set());
    setSelectedEcosystems(new Set());
    setSelectedEfforts(new Set());
    setSelectedMissionTypes(new Set());
  }

  function handleStatusChange(missionId: string, patch: MissionClaimPatch): void {
    setMissions((prev) => prev.map((m) => (m.id === missionId ? { ...m, ...patch } : m)));
  }

  // Derived lists are memoized so a keystroke or chip toggle doesn't rescan
  // every mission for every derived value. The haystack map is keyed by
  // mission id and only rebuilt when the missions array itself changes.
  const haystacksById = useMemo(
    () => new Map(stabilizedMissions.map((mission) => [mission.id, haystackOf(mission)])),
    [stabilizedMissions],
  );

  const searchMatched = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (needle === "") {
      return stabilizedMissions;
    }
    return stabilizedMissions.filter((mission) =>
      (haystacksById.get(mission.id) ?? "").includes(needle),
    );
  }, [stabilizedMissions, searchQuery, haystacksById]);

  // Each axis's chip counts are computed against every *other* active axis
  // (but not itself), so a count reflects "how many results if I also
  // picked this," not a static total that never moves.
  const { severityCounts, ecosystemCounts, effortCounts, missionTypeCounts, filtered } = useMemo(
    () => ({
      severityCounts: countBy(
        searchMatched.filter(
          (mission) =>
            matchesSet(mission.score.effortLabel, selectedEfforts) &&
            matchesSet(ecosystemOf(mission), selectedEcosystems) &&
            matchesSet(mission.missionType, selectedMissionTypes),
        ),
        severityOf,
      ),
      ecosystemCounts: countBy(
        searchMatched.filter(
          (mission) =>
            matchesSet(severityOf(mission), selectedSeverities) &&
            matchesSet(mission.score.effortLabel, selectedEfforts) &&
            matchesSet(mission.missionType, selectedMissionTypes),
        ),
        ecosystemOf,
      ),
      effortCounts: countBy(
        searchMatched.filter(
          (mission) =>
            matchesSet(severityOf(mission), selectedSeverities) &&
            matchesSet(ecosystemOf(mission), selectedEcosystems) &&
            matchesSet(mission.missionType, selectedMissionTypes),
        ),
        (mission) => mission.score.effortLabel,
      ),
      missionTypeCounts: countBy(
        searchMatched.filter(
          (mission) =>
            matchesSet(severityOf(mission), selectedSeverities) &&
            matchesSet(ecosystemOf(mission), selectedEcosystems) &&
            matchesSet(mission.score.effortLabel, selectedEfforts),
        ),
        (mission) => mission.missionType,
      ),
      filtered: searchMatched.filter(
        (mission) =>
          matchesSet(severityOf(mission), selectedSeverities) &&
          matchesSet(ecosystemOf(mission), selectedEcosystems) &&
          matchesSet(mission.score.effortLabel, selectedEfforts) &&
          matchesSet(mission.missionType, selectedMissionTypes),
      ),
    }),
    [searchMatched, selectedSeverities, selectedEcosystems, selectedEfforts, selectedMissionTypes],
  );

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => compareMissions(a, b, sortMode)),
    [filtered, sortMode],
  );
  const groups = useMemo(
    () => (groupByRepo ? groupByRepoKey(sorted) : null),
    [groupByRepo, sorted],
  );

  const isFiltered =
    selectedSeverities.size > 0 ||
    selectedEcosystems.size > 0 ||
    selectedEfforts.size > 0 ||
    selectedMissionTypes.size > 0 ||
    searchQuery.trim() !== "";

  // A per-repo board whose missions all share one ecosystem gets nothing
  // out of the ecosystem chip row — hide it unless a URL-supplied ecosystem
  // selection is active (which must stay visible or it becomes an
  // invisible filter).
  const availableEcosystems = useMemo(() => {
    const set = new Set<Ecosystem>();
    for (const mission of stabilizedMissions) {
      const ecosystem = ecosystemOf(mission);
      if (ecosystem !== null) {
        set.add(ecosystem);
      }
    }
    return set;
  }, [stabilizedMissions]);
  const hideEcosystemAxis = selectedEcosystems.size === 0 && availableEcosystems.size <= 1;

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
          selectedMissionTypes={selectedMissionTypes}
          onToggleMissionType={toggleMissionType}
          missionTypeCounts={missionTypeCounts}
          hideEcosystemAxis={hideEcosystemAxis}
          onClear={clearFilters}
        />
        <div
          className={`flex flex-wrap items-center gap-3 ${showGroupByRepo ? "justify-between" : "justify-end"}`}
        >
          {showGroupByRepo && (
            <label className="text-ink-muted flex items-center gap-2 font-mono text-xs">
              <input
                type="checkbox"
                checked={groupByRepo}
                onChange={(event) => {
                  setGroupByRepo(event.target.checked);
                }}
                className="accent-accent"
              />
              Group by repo
            </label>
          )}
          <label className="text-ink-muted flex items-center gap-2 font-mono text-xs">
            Sort
            <select
              value={sortMode}
              onChange={(event) => {
                setSortMode(parseSortParam(event.target.value));
              }}
              className="border-border bg-surface text-ink rounded-sm border px-2 py-1 font-mono text-xs"
            >
              {SORT_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {SORT_LABELS[mode]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {isFiltered && (
          <p className="text-ink-muted font-mono text-xs">
            {filtered.length} of {stabilizedMissions.length} missions
          </p>
        )}
      </div>

      {sorted.length === 0 ? (
        <EmptyFilterState />
      ) : groups !== null ? (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <div key={group.repoKey} className="flex flex-col gap-3">
              <h2 className="text-ink-muted border-border border-b pb-1 font-mono text-xs font-semibold uppercase tracking-wide">
                {group.repoKey}{" "}
                <span className="normal-case">({group.missions.length.toString()})</span>
              </h2>
              <ul className="flex flex-col gap-3">
                {group.missions.map((mission) => (
                  <li key={mission.id}>
                    <MissionCard mission={mission} onStatusChange={handleStatusChange} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* Cards are h3 (mission-card.tsx); this gives the flat list its
              h2 parent so the page's heading outline stays h1 → h2 → h3. */}
          <h2 className="sr-only">Missions</h2>
          <ul className="flex flex-col gap-3">
            {sorted.map((mission) => (
              <li key={mission.id}>
                <MissionCard mission={mission} onStatusChange={handleStatusChange} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
