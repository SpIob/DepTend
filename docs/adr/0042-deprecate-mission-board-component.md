# ADR 0042: Deprecate the per-repo `MissionBoard` client component in favor of the board-wide `PaginatedMissionBoard`

- **Status:** Accepted
- **Date:** 2026-08-29
- **Related:** ADR 0027 (repo directory / per-repo boards), ADR 0031 (paginated mission board), ADR 0033 (read-path caching), ADR 0012 (query placement)

## Context

The per-repo mission board (`/repo/[owner]/[name]`) and the board-wide listing (`/missions`) have been served by two parallel components since Phase 5:

- `app/src/components/mission-board.tsx` (client-side filtering / search / sort / group-by-repo) — used by the per-repo page since ADR 0027.
- `app/src/components/paginated-mission-board.tsx` (ADR 0031) — used by `/missions` since 2026-08-22; filter/sort/page live in the URL, drive a SQL `LIMIT/OFFSET` via `getBoardMissionsWithScoresPage`, and return a `BoardPage { missions, total, facets }`.

Both shared `MissionCard`, `MissionSearchInput`, and the URL query shape (`mission-board-query.ts`). They did **not** share the filter/sort/group-by-repo plumbing, which was independently implemented in each component and had already drifted:

- `EmptyFilterState` — byte-identical in both files.
- `repoKeyOf` / `groupByRepoKey` — byte-identical in both files.
- `severityOf` / `ecosystemOf` / `haystackOf` / `matchesSet` / `countBy` — live only in `mission-board.tsx`; `paginated-mission-board.tsx` had already moved them to SQL.
- `FilterChip` vs `Chip` — same shape, two copies; the per-repo `Chip` had no `disabled` prop, so it could never indicate in-flight state.

The audit at the end of Phase 6 found the duplication to be the single largest source of drift risk in the UI layer, and the deprecation question had been deferred three times (most recently in ADR 0031, which explicitly carved out the per-repo board: "the per-repo board keeps the old fully client-side component … already bounded, and keeping it means no regression risk to a working page"). Since then, ADR 0033 (read-path caching) and the locked ranking-parity tests have made the SQL-side facet computation safe to share with the per-repo page; the "regression risk" that kept the carve-out open has shrunk to a small `pageSize`/`pageCount` plumbing difference.

## Decision

Deprecate `MissionBoard` and `MissionFilterBar`; route the per-repo page to `PaginatedMissionBoard`.

1. **One server helper, one client component, two URLs.** Add `getRepoBoardPage(db, repoId, filters)` to `packages/core/src/db/queries.ts` — same `BoardPage` shape `PaginatedMissionBoard` already consumes, same `count(*) FILTER (...)` facet aggregate as the board-wide query, plus a `WHERE missions.repo_id = $1` constraint. The per-repo page calls it via `app/src/lib/queries/missions.ts`'s new `getRepoBoardPage(repoId, filters)` wrapper, which mirrors the existing `getBoardMissionsPage(filters, page)` wrapper, including the `unstable_cache` + `reviveDates` chain (same `missions` cache tag, same 60s TTL). Filters in the cache key; `page` is not, because pagination never paginates for a single repo.

2. **`PaginatedMissionBoard` gains one prop: `showGroupByRepo`.** Defaults to `true` (preserves `/missions` behavior). The per-repo page passes `false`, and the component:
   - Doesn't render the "Group by repo" checkbox.
   - Forces the initial `groupByRepo` state to `false` even if the URL has `?group=1` (mirrors the same defensive guard `mission-board.tsx:150` had — otherwise a deep link could leave the per-repo page in a single-bucket no-op state with no toggle to undo it).
   - Switches its bottom row from `justify-between` to `justify-end` so the sort control stays right-aligned without an empty left half.

3. **Page plumbing.** The per-repo page passes `pageSize={board.missions.length}`, `page={1}`, `pageCount={1}`. `pageCount > 1` is the gate on the pagination nav, so the buttons never render; `rangeStart`/`rangeEnd` compute to "1–N of N", which is the same per-repo counter the client-side board produced. The "no missions for this repo" empty state now fires only when the unfiltered set is empty (no `q`, no chip selections, and `board.missions.length === 0`); any filter zero-out falls through to `PaginatedMissionBoard`'s own `EmptyFilterState` (the filter-aware "Try clearing or loosening a filter above" copy).

4. **Delete the duplicates.** `app/src/components/mission-board.tsx` and `app/src/components/mission-filter-bar.tsx` are removed. `mission-filter-options.ts`'s header comment is updated to note the duplications it was created to fix are now gone. `queries.ts`'s SQL-mirror comments (which previously pointed at `mission-board.tsx` as the source of the JS-side `severityOf` / `ecosystemOf` it mirrors) are updated to point at the board UI generally, since those derivations now live only on the SQL side.

5. **No new ADR-worthy data shape.** `BoardFilters`, `BoardPage`, and `BoardFacets` are unchanged. `getRepoBoardPage` is a sibling of `getBoardMissionsWithScoresPage` (not a new parameter on it), keeping the public filter type semantic-free of single-repo shortcuts; callers stay uniform and the existing parity tests against `getBoardMissionsWithScoresPage` cover the SQL it shares.

## Alternatives considered

- **Extract a shared `mission-board-utils.ts`.** Lower-risk than deprecation but doesn't fix the deeper problem: two components, two filter codepaths, and the per-repo one is dead code the moment the per-repo page is on the server-side version. Kept the file purely as a forward-compat hedge; the audit said deprecate was the right call.
- **Keep the per-repo board and add a `useServerFilters` hook.** Same total work as deprecation, with none of the consolidation benefits, and leaves the duplicate `Chip`/`FilterChip` live. Rejected.
- **Add a `repoId?: string` to `BoardFilters`.** Smaller diff but mixes board scope with per-repo shortcuts in the public type; the per-repo call would still need the same `pageSize`/`pageCount` plumbing in the page. The sibling-function approach is the same number of lines with cleaner types.

## Consequences

- One filter codepath to maintain instead of two. New filter axes now land in one place (`mission-filter-options.ts` + `BOARD_*_EXPR` SQL) and one shape (`BoardFilters`).
- The per-repo page is now on the same cached, server-side filter path `/missions` already is. Claim/unclaim + bookmark mutations on the per-repo page still `revalidateTag("missions")`, so optimistic patches keep working (MissionCard's `onStatusChange` callback stays the same).
- The per-repo page no longer needs `getRepoMissionsWithScores`; the function stays exported from `app/src/lib/queries/missions.ts` and is still covered by `queries.test.ts`, but no longer has an `/app` caller. Leaving the function in place to avoid breaking the direct test surface; a future ADR can decide whether to delete it.
- The per-repo page's URL still doesn't carry `?page=`; a deep link `/repo/foo/bar?page=2` is silently ignored (the page renders with `page=1` because the URL `page` field is dropped on parse for the per-repo page). This matches the prior behavior of the client-side `MissionBoard`, which never paginated.
- `paginated-mission-board.tsx`'s `FILTER_DISABLED` prop wasn't introduced — the per-repo `Chip` lost its `disabled` gap in the audit's "extract `FilterChip`" recommendation, but that was explicitly out of scope for this pass. If the per-repo page later needs to indicate in-flight state, `FilterChip` will get a `disabled` prop in a follow-up (the audit's M1 item).

## Verification

Standard five-check loop clean at time of writing; one manual pass owed after merge + deploy to confirm:

- Per-repo page renders identically to the prior `MissionBoard` version with no filters and no group-by-repo control visible.
- A deep link `/repo/SpIob/deptend-go-test-fixture?severity=critical` filters the board; clicking the "X" severity chip navigates back to the unfiltered set; "View on GitHub", "← All repos", and bookmark toggle still work.
- An empty board (a repo with no open/claimed missions) shows the per-repo "No open missions for this repo" empty state when no filters are active, and `PaginatedMissionBoard`'s own "No missions match these filters" empty state when any filter is active.
- The mission board's "Updating…" indicator appears on debounced search and chip navigations; claim/unclaim from the per-repo page still optimistically updates the card and falls back to `router.refresh()` if no parent callback is provided (the `onStatusChange` is now always provided by `PaginatedMissionBoard`, so the optimistic path runs; this is the same behavior the board-wide listing already had).
- `/missions` and the directory `/` are unchanged.
