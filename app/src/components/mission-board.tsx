"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { Ecosystem, EffortLabel, Severity } from "@deptend/core/db/schema.js";
import type { MissionWithScore } from "@deptend/core";
import { MissionCard, type MissionClaimPatch } from "./mission-card";
import { MissionFilterBar } from "./mission-filter-bar";
import { MissionSearchInput } from "./mission-search";

const SEVERITY_VALUES: readonly Severity[] = ["critical", "high", "medium", "low", "unknown"];
const ECOSYSTEM_VALUES: readonly Ecosystem[] = ["npm", "pypi", "go"];
const EFFORT_VALUES: readonly EffortLabel[] = ["trivial", "low", "medium", "high"];

type SortMode = "priority" | "quick-wins" | "newest";
const SORT_MODES: readonly SortMode[] = ["priority", "quick-wins", "newest"];
const SORT_LABELS: Record<SortMode, string> = {
  priority: "Highest impact first",
  "quick-wins": "Quickest wins first",
  newest: "Newest advisory first",
};

// Lower number sorts first under "quick-wins" — trivial fixes surface before
// high-effort ones.
const EFFORT_ORDER: Record<EffortLabel, number> = { trivial: 0, low: 1, medium: 2, high: 3 };

/** Parsed, validated shape of everything this board keeps in the URL. */
export interface MissionBoardQuery {
  q: string;
  severity: ReadonlySet<Severity>;
  ecosystem: ReadonlySet<Ecosystem>;
  effort: ReadonlySet<EffortLabel>;
  sort: SortMode;
  group: boolean;
}

function parseSetParam<T extends string>(
  value: string | null,
  allowed: readonly T[],
): ReadonlySet<T> {
  if (value === null || value === "") {
    return new Set();
  }
  const allowedSet: ReadonlySet<string> = new Set(allowed);
  return new Set(value.split(",").filter((v): v is T => allowedSet.has(v)));
}

function parseSortParam(value: string | null): SortMode {
  return SORT_MODES.find((mode) => mode === value) ?? "priority";
}

/**
 * Reads the same query shape whether it came from Next's server-side
 * `searchParams` (page.tsx, on first load) or this component's own
 * client-side state serialization — one parser, one source of truth.
 */
export function parseMissionBoardQuery(params: {
  q?: string | undefined;
  severity?: string | undefined;
  ecosystem?: string | undefined;
  effort?: string | undefined;
  sort?: string | undefined;
  group?: string | undefined;
}): MissionBoardQuery {
  return {
    q: params.q ?? "",
    severity: parseSetParam(params.severity ?? null, SEVERITY_VALUES),
    ecosystem: parseSetParam(params.ecosystem ?? null, ECOSYSTEM_VALUES),
    effort: parseSetParam(params.effort ?? null, EFFORT_VALUES),
    sort: parseSortParam(params.sort ?? null),
    group: params.group === "1",
  };
}

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

function matchesSearch(mission: MissionWithScore, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  const haystack = [
    mission.title,
    mission.dependency?.packageName ?? "",
    repoKeyOf(mission),
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
}: {
  missions: MissionWithScore[];
  initialQuery: MissionBoardQuery;
}): React.JSX.Element {
  const pathname = usePathname();

  const [missions, setMissions] = useState(initialMissions);
  const [searchQuery, setSearchQuery] = useState(initialQuery.q);
  const [selectedSeverities, setSelectedSeverities] = useState(initialQuery.severity);
  const [selectedEcosystems, setSelectedEcosystems] = useState(initialQuery.ecosystem);
  const [selectedEfforts, setSelectedEfforts] = useState(initialQuery.effort);
  const [sortMode, setSortMode] = useState(initialQuery.sort);
  const [groupByRepo, setGroupByRepo] = useState(initialQuery.group);

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

  const sorted = [...filtered].sort((a, b) => compareMissions(a, b, sortMode));
  const groups = groupByRepo ? groupByRepoKey(sorted) : null;

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
        <div className="flex flex-wrap items-center justify-between gap-3">
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
            {filtered.length} of {missions.length} missions
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
        <ul className="flex flex-col gap-3">
          {sorted.map((mission) => (
            <li key={mission.id}>
              <MissionCard mission={mission} onStatusChange={handleStatusChange} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
