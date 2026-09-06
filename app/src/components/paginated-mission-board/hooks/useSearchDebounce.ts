"use client";

import { useEffect, useRef, useState } from "react";
import type { MissionBoardQuery } from "@/lib/mission-board-query";

interface UseSearchDebounceOptions {
  initialQuery: MissionBoardQuery;
  /** Called when the debounced search should trigger a navigation. */
  onSearchNavigate: (search: string) => void;
}

export function useSearchDebounce({
  initialQuery,
  onSearchNavigate,
}: UseSearchDebounceOptions): [string, (value: string) => void] {
  const [search, setSearch] = useState(initialQuery.q);

  // The not-yet-fired debounced search navigation, if any. Explicit user
  // navigations cancel it; see the returned navigate function.
  const pendingSearchNav = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Always holds the most recent render's onSearchNavigate, so a deferred search
  // commit folds in query-shaping state that changed after the timer was
  // armed instead of reverting it with a closure frozen at arm time.
  const latestOnSearchNavigate = useRef(onSearchNavigate);
  useEffect(() => {
    latestOnSearchNavigate.current = onSearchNavigate;
  });

  // Debounced search navigation. The guard skips the mount render (state
  // still equals the server's value), so only real edits fire a navigation.
  useEffect(() => {
    if (search === initialQuery.q) {
      return;
    }
    const handle = setTimeout(() => {
      pendingSearchNav.current = null;
      const navigate = latestOnSearchNavigate.current;
      if (navigate !== undefined) {
        navigate(search);
      }
    }, 300);
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
    // time (latestOnSearchNavigate), so they don't need to re-arm it either.
  }, [search, initialQuery.q]);

  return [search, setSearch];
}
