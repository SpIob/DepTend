"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  MissionBoardQuery,
  MissionBoardQueryState,
  SortMode,
} from "@/lib/mission-board-query";
import { buildMissionBoardHref } from "@/lib/mission-board-query";

interface UseBoardNavigationOptions {
  basePath: string;
  initialQuery: MissionBoardQuery;
  /** Current groupByRepo state (for buildHref) */
  groupByRepo: boolean;
  /** Current search state (for buildHref) */
  search: string;
  /** Mode: "server" (default) uses router.replace for navigation; "client" updates local state and syncs URL */
  mode?: "server" | "client";
  /** Called when filters change in client mode */
  onFilterChange?: (query: MissionBoardQuery) => void;
  /** Called when sort changes in client mode */
  onSortChange?: (sort: SortMode) => void;
}

export function useBoardNavigation({
  basePath,
  initialQuery,
  groupByRepo,
  search,
  mode = "server",
  onFilterChange,
  onSortChange,
}: UseBoardNavigationOptions) {
  const router = useRouter();
  const [inFlight, setInFlight] = useState(0);
  const inFlightRef = useRef(0);

  // Client mode: maintain local query state
  const [clientQuery, setClientQuery] = useState<MissionBoardQuery>(initialQuery);

  // Every board interaction funnels through here so one isPending flag can
  // cover chips, sort, clear, pagination, and the debounced search commit.
  function navigate(href: string): void {
    inFlightRef.current += 1;
    setInFlight(inFlightRef.current);
    router.replace(href);
  }

  // Builds a board URL from the server-rendered filter state plus per-call
  // overrides. Includes current page so filter/sort/search/clear navigation
  // preserves the current page (pagination buttons pass explicit page override).
  function buildHref(overrides: MissionBoardQueryState): string {
    const sourceQuery = mode === "client" ? clientQuery : initialQuery;
    return buildMissionBoardHref(basePath, {
      q: search,
      severity: sourceQuery.severity,
      ecosystem: sourceQuery.ecosystem,
      effort: sourceQuery.effort,
      missionType: sourceQuery.missionType,
      sort: sourceQuery.sort,
      group: groupByRepo,
      page: sourceQuery.page,
      ...overrides,
    });
  }

  // Client mode: update local state and sync URL without full navigation
  function updateClientQuery(updates: Partial<MissionBoardQuery>): void {
    setClientQuery((prev) => {
      const next = { ...prev, ...updates };
      if (onFilterChange) {
        onFilterChange(next);
      }
      // Sync URL for shareable links (no navigation, just URL update)
      if (mode === "client") {
        const href = buildMissionBoardHref(basePath, {
          q: next.q,
          severity: next.severity,
          ecosystem: next.ecosystem,
          effort: next.effort,
          missionType: next.missionType,
          sort: next.sort,
          group: next.group,
          page: next.page,
        });
        router.replace(href);
      }
      return next;
    });
  }

  function updateClientSort(sort: SortMode): void {
    setClientQuery((prev) => {
      const next = { ...prev, sort };
      if (onSortChange) {
        onSortChange(sort);
      }
      if (mode === "client") {
        const href = buildMissionBoardHref(basePath, {
          q: next.q,
          severity: next.severity,
          ecosystem: next.ecosystem,
          effort: next.effort,
          missionType: next.missionType,
          sort: next.sort,
          group: next.group,
          page: next.page,
        });
        router.replace(href);
      }
      return next;
    });
  }

  const isPending = inFlight > 0;

  return {
    navigate,
    buildHref,
    isPending,
    inFlight,
    inFlightRef,
    setInFlight,
    // Client mode exports
    clientQuery: mode === "client" ? clientQuery : initialQuery,
    setClientQuery: mode === "client" ? updateClientQuery : undefined,
    setClientSort: mode === "client" ? updateClientSort : undefined,
  };
}
