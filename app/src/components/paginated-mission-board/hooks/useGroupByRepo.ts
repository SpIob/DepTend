"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { MissionBoardQuery } from "@/lib/mission-board-query";
import { buildMissionBoardHref } from "@/lib/mission-board-query";

interface UseGroupByRepoOptions {
  showGroupByRepo: boolean;
  initialQuery: MissionBoardQuery;
  page: number;
}

export function useGroupByRepo({
  showGroupByRepo,
  initialQuery,
  page,
}: UseGroupByRepoOptions): [boolean, (checked: boolean) => void] {
  const pathname = usePathname();
  // Mirrors MissionBoard's "even if URL says group=1, ignore it when the
  // control is hidden" rule. Without this, a deep link could leave the
  // per-repo page in a single-group state with no toggle to undo it.
  const [groupByRepo, setGroupByRepo] = useState(showGroupByRepo && initialQuery.group);

  // Group-by-repo is pure presentation over the current page — it never
  // changes the query, so it syncs via replaceState instead of navigating.
  useEffect(() => {
    if (!showGroupByRepo) return;
    // Skip if groupByRepo hasn't actually changed from the server value
    // (avoids redundant replaceState on every server render)
    if (groupByRepo === initialQuery.group) return;
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
  }, [groupByRepo, pathname, initialQuery, page, showGroupByRepo]);

  const handleGroupByRepoChange = (checked: boolean): void => {
    setGroupByRepo(checked);
  };

  return [groupByRepo, handleGroupByRepoChange];
}
