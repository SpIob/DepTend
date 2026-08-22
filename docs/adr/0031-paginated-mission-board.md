# ADR 0031: Server-side filtering and pagination for the board-wide mission listing

- **Status:** Accepted
- **Date:** 2026-08-22
- **Related:** ADR 0017 (ranking tie-break bucketing), ADR 0018 (final tie-break), ADR 0027
  (repo directory / per-repo boards), ADR 0025 (rate limiting), known-issues list in AGENTS.md

## Context

The board-wide `/missions` page shipped in Phase 5 with a simple architecture: one unbounded
query (`getBoardMissionsWithScores`) returned every open+claimed mission across every repo,
and the browser did all filtering, searching, sorting, and rendering client-side over the
full array. That was fine at three repos. At the 150-repo launch cap it stopped being fine:

- The DB read, the RSC payload, and the client's working set all grew linearly with total
  missions. This was the long-standing "unbounded DB query" known issue.
- Client-side filtering meant any fix that bounded the payload (a LIMIT) would silently break
  filter semantics — chips could only ever match inside the loaded window.

The per-repo boards (`/repo/[owner]/[name]`, ADR 0027) do NOT have this problem — their cost
is bounded by one repo's mission count — and the landing page already avoids shipping full
mission payloads (`getReposWithMissionSummary` ships aggregated counts).

## Decision

Move `/missions`' filtering, searching, ordering, and pagination into SQL, behind a new core
function `getBoardMissionsWithScoresPage(db, filters, {limit, offset})` returning one page of
full missions plus an unpaginated `total` and per-axis facet counts. Specifically:

1. **Filters become WHERE clauses**, mirroring the old client helpers exactly:
   - severity = `COALESCE(advisories.severity::text, 'unknown')` (was `severityOf()`)
   - ecosystem = `COALESCE(dependencies.ecosystem::text, advisories.ecosystem::text)` (was
     `ecosystemOf()`; NULL when both sources are null — excluded by `IN`, matching the old
     `matchesSet()` behavior)
   - search q matches title, package name, `owner/name`, and OSV id via `ILIKE ... ESCAPE`,
     with LIKE metacharacters escaped so `%`/`_` match literally (matching
     `String.includes()`)
2. **Ordering happens in Postgres**, using the exact key sequence `rankMissions()` already
   defines (ADR 0017/0018): tier-bucketed composite score (same 0.5-width buckets) DESC,
   effort-rank ASC, `published_at DESC NULLS LAST`, then `COALESCE(osv_id, mission.id)` ASC
   as the absolute unique fallback that makes OFFSET pagination deterministic. The two
   other sort modes ("quick-wins", "newest") get equivalent fully-deterministic SQL orderings.
   `rankMissions()` itself is untouched and remains the ranking implementation for the CLI
   and the fetch-everything paths.
3. **Facet counts move server-side too**: each axis's chip counts are aggregates matching
   every _other_ active axis plus q (but not itself) — the same semantics the client
   computed — so a chip still answers "how many results if I also picked this."
4. **Page size is fixed at 50** (`BOARD_PAGE_SIZE` in core). Out-of-range `?page=` values are
   canonicalized by redirecting to the last valid page rather than rendering a blank screen.
5. **Filter interactions navigate**: chips and sort are URL changes (`router.replace`),
   pagination uses `<Link>`; search input keeps instant local feedback and debounces its
   navigation (~300 ms). The component re-mounts per navigation (keyed by serialized query)
   so local state can never drift from server state. Claim/unclaim keeps working via
   optimistic patches on the page's own rows; MissionCard's parent-patch callback became
   optional and falls back to `router.refresh()` where no parent copy exists.
6. **The per-repo board keeps the old fully client-side component** (`MissionBoard`) — it is
   already bounded, and keeping it means no regression risk to a working page. The two
   boards share MissionCard, the search input markup, and the URL query shape
   (`mission-board-query.ts`), deliberately not their filtering logic.
7. **Count hygiene in the same pass**: `getIndexedRepoCount`/`getTotalRepoCount` now use
   `count(*)` instead of selecting every repo id into memory.

## Alternatives considered

- **Hard cap + sort (LIMIT without filters)** — smallest diff, but silently hides missions
  past the cap and leaves filter semantics broken for anything beyond the window.
- **Keep client-side everything, just slice the payload** — same semantic break as above.
- **Leave as-is until data volume forces it** — rejected: the payload grows with _total_
  missions across 150 repos, which was always the point of raising the cap; waiting meant
  shipping a known O(N) regression path at launch scale.

## Consequences

- `/missions` payload is bounded per request regardless of board size; DB cost per view is
  five bounded queries (one page select + four small aggregates) instead of one unbounded one.
- Filtering/search/sort now round-trip the server per interaction. This is the standard
  server-rendered-tables trade; the old design's avoidance of navigations (documented in the
  prior component) existed precisely because filtering operated on already-loaded data — once
  filtering moved server-side that reason evaporated.
- Ranking semantics are duplicated between JS (`rankMissions`) and SQL fragments. This is a
  deliberate, commented mirror (the alternative — moving ranking into SQL everywhere — would
  drag the CLI's in-memory path along with it). The unit of correctness is: both produce the
  same order for the same inputs. If scoring keys ever change, both must move together; the
  SQL side cites ADR 0017/0018 at each fragment.
- The absolute final tie-break uses Postgres collation rather than `localeCompare`. This only
  differs for two advisories sharing tier, effort AND exact `published_at`; the requirement is
  determinism across pages, which holds either way.

## Verification

Standard five-check loop clean at time of writing. Still owed before flipping to Accepted:

- A live pass against the dev Neon branch: page through `/missions` with filters active,
  confirm facet counts match the old client-computed ones, confirm claim/unclaim from a
  filtered page 2+ lands correctly, and confirm an out-of-range `?page=` redirects.
- Cross-check that the SQL "priority" ordering matches the CLI's `rankMissions()` output on
  the same dataset (the Phase 4 cross-validation trick that caught ADR 0018).
