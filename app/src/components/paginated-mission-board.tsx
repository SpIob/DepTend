"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { BoardFacets } from "@deptend/core/db/queries.js";
import type { MissionWithScore } from "@deptend/core";
import {
  buildMissionBoardHref,
  SORT_LABELS,
  SORT_MODES,
  toggledSet,
  type MissionBoardQuery,
  type MissionBoardQueryState,
  type SortMode,
} from "@/lib/mission-board-query";
import {
  ECOSYSTEM_LABELS,
  ECOSYSTEM_OPTIONS,
  EFFORT_LABELS,
  EFFORT_OPTIONS,
  MISSION_TYPE_LABELS,
  MISSION_TYPE_OPTIONS,
  SEVERITY_LABELS,
  SEVERITY_OPTIONS,
} from "@/lib/mission-filter-options";
import { MissionCardMemo as MissionCard, type MissionClaimPatch } from "./mission-card";
import { MissionSearchInput } from "./mission-search";

/** Milliseconds of search-input idle time before the debounced navigation fires. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The mission board, used by both /missions (board-wide, ADR 0031) and
 * /repo/[owner]/[name] (per-repo, ADR 0027 + ADR 0041). Filtering, searching,
 * sorting, and pagination all happen server-side: this component renders
 * exactly one pre-filtered page handed to it by the page component and
 * turns every filter interaction into a URL change (via router.replace
 * inside one shared transition), which re-runs the server query. The
 * search input is the one exception. It keeps instant local feedback and
 * debounces its navigation so typing does not fire a request per keystroke.
 *
 * The board is intentionally not keyed by its URL. A key would remount it
 * on every navigation and drop the search input's focus mid-typing, so
 * the component instead adopts each fresh missions array as it arrives
 * (see the adjust-state block below) while user-owned state survives.
 *
 * The per-repo page passes `pageSize = missions.length`, `page = 1`, and
 * `pageCount = 1` so the pagination UI never renders. The per-repo filter
 * chip set still does. Both boards share MissionCard, the search input
 * markup, the filter chip component, and the URL query shape
 * (mission-board-query.ts). The surface differences are the pagination
 * controls on /missions and the hidden "Group by repo" toggle on the
 * per-repo page, since every row on that page already belongs to one repo
 * and grouping would be a single-bucket no-op.
 */

const CHIP_ACTIVE_CLASS = "border-accent bg-accent text-white";
const CHIP_IDLE_CLASS = "border-border text-ink-muted hover:text-ink hover:border-ink-muted";

function FilterChip({
  onToggle,
  label,
  count,
  active,
  disabled,
}: {
  onToggle: () => void;
  label: string;
  count: number | undefined;
  active: boolean;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={active}
      className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors disabled:opacity-50 ${
        active ? CHIP_ACTIVE_CLASS : CHIP_IDLE_CLASS
      }`}
    >
      {label}
      {count !== undefined ? ` (${count.toString()})` : ""}
    </button>
  );
}

function EmptyFilterState(): React.JSX.Element {
  return (
    <div className="border-border bg-surface rounded-sm border border-dashed p-10 text-center">
      <p className="text-ink font-medium">No missions match these filters.</p>
      <p className="text-ink-muted mt-1 text-sm">Try clearing or loosening a filter above.</p>
    </div>
  );
}

interface MissionGroup {
  repoKey: string;
  missions: MissionWithScore[];
}

function repoKeyOf(mission: MissionWithScore): string {
  return `${mission.repo.owner}/${mission.repo.name}`;
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

export function PaginatedMissionBoard({
  missions: initialMissions,
  total,
  facets,
  pageSize,
  page,
  pageCount,
  initialQuery,
  basePath,
  /**
   * Hide the "Group by repo" checkbox. The per-repo page passes false
   * because every mission on that board already belongs to one repo, so
   * the toggle would always produce a single bucket. Defaults to true so
   * /missions (the board-wide listing) keeps the affordance. Mirrors
   * the same option the older MissionBoard exposed.
   */
  showGroupByRepo = true,
}: {
  missions: MissionWithScore[];
  /** Total missions matching the filters across all pages — not this page's count. */
  total: number;
  facets: BoardFacets;
  /** Rows per page — the server's BOARD_PAGE_SIZE, needed for the range line. */
  pageSize: number;
  page: number;
  pageCount: number;
  initialQuery: MissionBoardQuery;
  basePath: string;
  showGroupByRepo?: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const [missions, setMissions] = useState(initialMissions);
  const [search, setSearch] = useState(initialQuery.q);
  // Mirrors MissionBoard's "even if URL says group=1, ignore it when the
  // control is hidden" rule. Without this, a deep link could leave the
  // per-repo page in a single-group state with no toggle to undo it.
  const [groupByRepo, setGroupByRepo] = useState(showGroupByRepo && initialQuery.group);

  // The board is deliberately NOT keyed by its URL (a key would remount it
  // on every debounced search commit and drop the input's focus mid-typing).
  // Instead, when the server hands back a fresh missions array, adopt it —
  // the React-documented adjust-state-on-prop-change pattern. Local state
  // that the user owns (search text, grouping) intentionally survives.
  const [lastServerMissions, setLastServerMissions] = useState(initialMissions);
  if (lastServerMissions !== initialMissions) {
    setLastServerMissions(initialMissions);
    setMissions(initialMissions);
  }

  const isFiltered =
    initialQuery.severity.size > 0 ||
    initialQuery.ecosystem.size > 0 ||
    initialQuery.effort.size > 0 ||
    initialQuery.missionType.size > 0 ||
    initialQuery.q.trim() !== "";

  // The not-yet-fired debounced search navigation, if any. Explicit user
  // navigations (navigate()) cancel it; see both functions below.
  const pendingSearchNav = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Always holds the most recent render's URL builder, so a deferred search
  // commit folds in query-shaping state that changed after the timer was
  // armed (a group-by toggle's replaceState, say) instead of reverting it
  // with a closure frozen at arm time. Refreshed in an effect below.
  const latestBuildHref = useRef<((overrides: MissionBoardQueryState) => string) | undefined>(
    undefined,
  );
  useEffect(() => {
    latestBuildHref.current = buildHref;
  });

  // Every board interaction funnels through here so one isPending flag can
  // cover chips, sort, clear, pagination, and the debounced search commit.
  function navigate(href: string): void {
    // A user-initiated navigation supersedes any armed search commit: the
    // href being navigated to already carries the input's current text
    // (buildHref's base reads live `search` state), so letting the armed
    // timer also fire would replay an older, filter-less URL over the top
    // of this one and silently undo the click that triggered it.
    if (pendingSearchNav.current !== null) {
      clearTimeout(pendingSearchNav.current);
      pendingSearchNav.current = null;
    }
    startTransition(() => {
      router.replace(href);
    });
  }

  // Builds a board URL from the server-rendered filter state plus per-call
  // overrides. `page` is deliberately absent from the base: every
  // filter/sort/search/clear navigation should land at the top of the
  // freshly-filtered ranking (the serializer omits page 1 entirely), and
  // the only callers that want a specific page — the pagination buttons —
  // pass it as an explicit override.
  function buildHref(overrides: MissionBoardQueryState): string {
    return buildMissionBoardHref(basePath, {
      q: search,
      severity: initialQuery.severity,
      ecosystem: initialQuery.ecosystem,
      effort: initialQuery.effort,
      missionType: initialQuery.missionType,
      sort: initialQuery.sort,
      group: groupByRepo,
      ...overrides,
    });
  }

  // Debounced search navigation. The guard skips the mount render (state
  // still equals the server's value), so only real edits fire a replace.
  useEffect(() => {
    if (search === initialQuery.q) {
      return;
    }
    const handle = setTimeout(() => {
      pendingSearchNav.current = null;
      const build = latestBuildHref.current;
      if (build !== undefined) {
        navigate(build({ q: search }));
      }
    }, SEARCH_DEBOUNCE_MS);
    pendingSearchNav.current = handle;
    return (): void => {
      clearTimeout(handle);
      if (pendingSearchNav.current === handle) {
        pendingSearchNav.current = null;
      }
    };
    // Deliberately keyed on `search` alone: re-arming the timer on
    // unrelated re-renders (e.g. claim patches) would only delay a
    // navigation that's still correct. Filter/sort/group changes either
    // cancel the timer outright (navigate()) or are folded in at fire
    // time (latestBuildHref), so they don't need to re-arm it either.
  }, [search]);

  // Group-by-repo is pure presentation over the current page — it never
  // changes the query, so it syncs via replaceState instead of navigating.
  useEffect(() => {
    const query = buildMissionBoardHref(pathname, {
      q: initialQuery.q,
      severity: initialQuery.severity,
      ecosystem: initialQuery.ecosystem,
      effort: initialQuery.effort,
      sort: initialQuery.sort,
      group: groupByRepo,
      page,
    }).split("?")[1];
    window.history.replaceState(null, "", query === undefined ? pathname : `${pathname}?${query}`);
  }, [groupByRepo, pathname, initialQuery, page]);

  function handleStatusChange(missionId: string, patch: MissionClaimPatch): void {
    setMissions((prev) => prev.map((m) => (m.id === missionId ? { ...m, ...patch } : m)));
  }

  const groups = groupByRepo ? groupByRepoKey(missions) : null;
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-bg border-border sticky top-0 z-10 flex flex-col gap-3 border-b py-3">
        <MissionSearchInput value={search} onChange={setSearch} />
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink-muted w-20 shrink-0 font-mono text-xs uppercase tracking-wide">
              Impact
            </span>
            {SEVERITY_OPTIONS.map((severity) => (
              <FilterChip
                key={severity}
                onToggle={() => {
                  navigate(buildHref({ severity: toggledSet(initialQuery.severity, severity) }));
                }}
                label={SEVERITY_LABELS[severity]}
                count={facets.severity[severity]}
                active={initialQuery.severity.has(severity)}
                disabled={isPending}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink-muted w-20 shrink-0 font-mono text-xs uppercase tracking-wide">
              Ecosystem
            </span>
            {ECOSYSTEM_OPTIONS.map((ecosystem) => (
              <FilterChip
                key={ecosystem}
                onToggle={() => {
                  navigate(buildHref({ ecosystem: toggledSet(initialQuery.ecosystem, ecosystem) }));
                }}
                label={ECOSYSTEM_LABELS[ecosystem]}
                count={facets.ecosystem[ecosystem]}
                active={initialQuery.ecosystem.has(ecosystem)}
                disabled={isPending}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink-muted w-20 shrink-0 font-mono text-xs uppercase tracking-wide">
              Effort
            </span>
            {EFFORT_OPTIONS.map((effort) => (
              <FilterChip
                key={effort}
                onToggle={() => {
                  navigate(buildHref({ effort: toggledSet(initialQuery.effort, effort) }));
                }}
                label={EFFORT_LABELS[effort]}
                count={facets.effort[effort]}
                active={initialQuery.effort.has(effort)}
                disabled={isPending}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink-muted w-20 shrink-0 font-mono text-xs uppercase tracking-wide">
              Type
            </span>
            {MISSION_TYPE_OPTIONS.map((type) => (
              <FilterChip
                key={type}
                onToggle={() => {
                  navigate(buildHref({ missionType: toggledSet(initialQuery.missionType, type) }));
                }}
                label={MISSION_TYPE_LABELS[type]}
                count={facets.missionType[type]}
                active={initialQuery.missionType.has(type)}
                disabled={isPending}
              />
            ))}
          </div>
          {isFiltered && (
            <button
              type="button"
              onClick={() => {
                navigate(
                  buildHref({
                    q: "",
                    severity: new Set(),
                    ecosystem: new Set(),
                    effort: new Set(),
                    missionType: new Set(),
                  }),
                );
              }}
              disabled={isPending}
              className="text-accent hover:text-ink self-start font-mono text-xs underline decoration-dotted underline-offset-2 disabled:opacity-50"
            >
              Clear filters
            </button>
          )}
        </div>
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
              value={initialQuery.sort}
              onChange={(event) => {
                navigate(buildHref({ sort: event.target.value as SortMode }));
              }}
              disabled={isPending}
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
        {(isFiltered || pageCount > 1 || isPending) && (
          <p className="text-ink-muted font-mono text-xs">
            {rangeStart.toString()}–{rangeEnd.toString()} of {total.toString()} missions
            {isPending && (
              <span role="status" className="text-accent ml-3">
                Updating…
              </span>
            )}
          </p>
        )}
      </div>

      {missions.length === 0 ? (
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
            {missions.map((mission) => (
              <li key={mission.id}>
                <MissionCard mission={mission} onStatusChange={handleStatusChange} />
              </li>
            ))}
          </ul>
        </>
      )}

      {pageCount > 1 && (
        <nav aria-label="Mission pages" className="flex items-center justify-between pt-2">
          {page > 1 ? (
            <button
              type="button"
              onClick={() => {
                navigate(buildHref({ page: page - 1 }));
              }}
              disabled={isPending}
              className="border-border text-ink-muted hover:text-ink hover:border-ink-muted rounded-md border px-3 py-1.5 font-mono text-xs disabled:opacity-50"
            >
              ← Previous
            </button>
          ) : (
            <span className="border-border text-ink-muted/50 rounded-md border px-3 py-1.5 font-mono text-xs">
              ← Previous
            </span>
          )}
          <span className="text-ink-muted font-mono text-xs">
            Page {page.toString()} of {pageCount.toString()}
          </span>
          {page < pageCount ? (
            <button
              type="button"
              onClick={() => {
                navigate(buildHref({ page: page + 1 }));
              }}
              disabled={isPending}
              className="border-border text-ink-muted hover:text-ink hover:border-ink-muted rounded-md border px-3 py-1.5 font-mono text-xs disabled:opacity-50"
            >
              Next →
            </button>
          ) : (
            <span className="border-border text-ink-muted/50 rounded-md border px-3 py-1.5 font-mono text-xs">
              Next →
            </span>
          )}
        </nav>
      )}
    </div>
  );
}
