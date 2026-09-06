"use client";

import { useEffect, useState } from "react";
import type { BoardFacets } from "@deptend/core/db/queries.js";
import type { MissionWithScore } from "@deptend/core";
import {
  SORT_LABELS,
  SORT_MODES,
  type MissionBoardQuery,
  type SortMode,
} from "@/lib/mission-board-query";
import { MissionCardMemo as MissionCard } from "../mission-card";
import { MissionSearchInput } from "../mission-search";
import { FilterChips, EmptyFilterState } from "./FilterChips";
import { Pagination } from "./Pagination";
import { groupByRepoKey } from "./groupByRepoKey";
import { useSearchDebounce } from "./hooks/useSearchDebounce";
import { useBoardNavigation } from "./hooks/useBoardNavigation";
import { useGroupByRepo } from "./hooks/useGroupByRepo";
import { useMissionStatusSync } from "./hooks/useMissionStatusSync";

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
  // Navigation + in-flight counter
  const { navigate, buildHref, isPending, inFlight, inFlightRef, setInFlight } = useBoardNavigation(
    {
      basePath,
      initialQuery,
      groupByRepo: false, // Will be overridden by useGroupByRepo's state
      search: "", // Will be overridden by useSearchDebounce's state
    },
  );

  // Search debounce
  const [search, setSearch] = useSearchDebounce({
    initialQuery,
    onSearchNavigate: (searchValue) => {
      navigate(buildHref({ q: searchValue }));
    },
  });

  // Group by repo
  const [groupByRepo, setGroupByRepo] = useGroupByRepo({
    showGroupByRepo,
    initialQuery,
    page,
  });

  // Mission status sync
  const [missions, handleStatusChange, resetMissions] = useMissionStatusSync(initialMissions);

  // The "Updating…" indicator is now driven by a local in-flight counter
  // (one request in = ++, RSC settles = --) instead of useTransition. The
  // transition-based version piled up on rapid clicks because a second
  // startTransition would queue behind the first and never settle until
  // Vercel's free-tier Neon round-trip (~20s) cleared. Imperative
  // router.replace + a counter keeps the indicator honest and prevents
  // the per-click stall the audit surfaced.

  // Sync inFlightRef with inFlight for the adjust-state block below
  useEffect(() => {
    inFlightRef.current = inFlight;
  }, [inFlight]);

  // The board is deliberately NOT keyed by its URL (a key would remount it
  // on every debounced search commit and drop the input's focus mid-typing).
  // Instead, when the server hands back a fresh missions array, adopt it —
  // the React-documented adjust-state-on-prop-change pattern. Local state
  // that the user owns (search text, grouping) intentionally survives.
  //
  // The "fresh missions array arrived" check is also where we settle the
  // in-flight counter: every navigation the user fires increments it,
  // and each completed server response decrements it. The counter can
  // safely drop to zero and stay there if a request was abandoned.
  const [lastServerMissions, setLastServerMissions] = useState(initialMissions);
  if (lastServerMissions !== initialMissions) {
    setLastServerMissions(initialMissions);
    resetMissions();
    if (inFlightRef.current > 0) {
      inFlightRef.current -= 1;
      setInFlight(inFlightRef.current);
    }
  }

  const isFiltered =
    initialQuery.severity.size > 0 ||
    initialQuery.ecosystem.size > 0 ||
    initialQuery.effort.size > 0 ||
    initialQuery.missionType.size > 0 ||
    initialQuery.q.trim() !== "";

  const groups = groupByRepo ? groupByRepoKey(missions) : null;
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-bg border-border sticky top-0 z-10 flex flex-col gap-3 border-b py-3">
        <MissionSearchInput value={search} onChange={setSearch} />
        <FilterChips
          initialQuery={initialQuery}
          facets={facets}
          isPending={isPending}
          navigate={navigate}
          buildHref={buildHref}
        />
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

      <Pagination
        page={page}
        pageCount={pageCount}
        isPending={isPending}
        navigate={navigate}
        buildHref={buildHref}
      />
    </div>
  );
}
