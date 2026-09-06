"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { MissionBoardQuery, MissionBoardQueryState } from "@/lib/mission-board-query";
import { buildMissionBoardHref } from "@/lib/mission-board-query";

interface UseBoardNavigationOptions {
  basePath: string;
  initialQuery: MissionBoardQuery;
  /** Current groupByRepo state (for buildHref) */
  groupByRepo: boolean;
  /** Current search state (for buildHref) */
  search: string;
}

export function useBoardNavigation({
  basePath,
  initialQuery,
  groupByRepo,
  search,
}: UseBoardNavigationOptions) {
  const router = useRouter();
  const [inFlight, setInFlight] = useState(0);
  const inFlightRef = useRef(0);

  // Every board interaction funnels through here so one isPending flag can
  // cover chips, sort, clear, pagination, and the debounced search commit.
  function navigate(href: string): void {
    inFlightRef.current += 1;
    setInFlight(inFlightRef.current);
    router.replace(href);
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

  const isPending = inFlight > 0;

  return { navigate, buildHref, isPending, inFlight, inFlightRef, setInFlight };
}
