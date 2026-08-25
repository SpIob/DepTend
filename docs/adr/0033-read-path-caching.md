# ADR 0033 — Read-path caching for shared dashboard queries

**Status:** Proposed (correction applied 2026-08-23; flips to Accepted once the fix below is verified on the deployed site)
**Date:** 2026-08-23

---

## Context

Nothing between the browser and Neon was ever cached: all three pages are `force-dynamic` (deliberately — see the comments in each page file), core has no memoization layer, and every page view paid full query cost. The performance pass that motivated this ADR measured where page time actually goes and found three compounding factors: every read is a live round trip to Neon (in AP-Southeast-1), `/missions` fires a five-table join twice per request (page rows + the ADR 0031 count/facet fan-out), and the homepage runs four parallel queries including the unindexed `dependencies` scan (closed separately by ADR 0034).

The freshness constraint shapes everything: mission claims and unclaims, bookmarks, submissions, and withdrawals are user-visible writes whose effects must appear immediately. Ingestion writes are different — they land through the external GitHub Actions cron (`scripts/ingest.js`), which runs outside Next.js and cannot call `revalidateTag`. Mico set the acceptable staleness for ingestion-driven data at **60 seconds**.

## Decision 1 — Cache at the query-wrapper layer, not the page

`app/src/lib/queries/missions.ts` wraps the shared, slowly-changing reads in `unstable_cache` with a 60-second revalidate window. Pages keep `export const dynamic = "force-dynamic"` untouched — the cache sits under them, so session handling, per-request searchParams parsing, and redirects behave exactly as before. All Drizzle query-building stays in packages/core (ADR 0012); only caching glue lives in `/app`.

Cached (and under which tag):

| Read                                                            | Key                       | Tag        |
| --------------------------------------------------------------- | ------------------------- | ---------- |
| `getBoardMissionsPage(filters, page)`                           | serialized filters + page | `missions` |
| `getRepoMissionsWithScores(repoId)`                             | repo id                   | `missions` |
| `getRepoDirectoryBase()`                                        | constant                  | `repos`    |
| `getIndexedRepoCount` / `getTotalRepoCount` / `getSkippedRepos` | constant                  | `repos`    |

Never cached: `getRepoByOwnerAndName` and `getRepoEcosystems` (cheap indexed lookups on a page that must reflect withdrawal instantly), and everything bookmark-shaped — bookmarks overlay fresh on every request so a toggle never waits on the cache. To make that split possible, core's `getReposWithMissionSummary(db, login)` was divided into a login-independent `getRepoDirectoryBase(db)` plus a bookmark-overlay wrapper; the public wrapper's observable behavior is unchanged (signed-out callers still skip the bookmarks query entirely).

## Decision 2 — Two tags, invalidated by the mutating routes

The whole cache answers to two tags, `"missions"` and `"repos"`, revalidated same-process by the API routes on success only:

| Route (success path)          | Tags revalidated    | Why                                                                        |
| ----------------------------- | ------------------- | -------------------------------------------------------------------------- |
| claim / unclaim               | `missions`, `repos` | board rows change; directory severity counts include open+claimed missions |
| submit (created outcome only) | `repos`             | new row changes directory, counts, cap denominator                         |
| withdraw (`withdrawn`)        | `repos`, `missions` | cascade delete removes the repo's missions from the board                  |

Bookmark/unbookmark revalidate nothing — bookmark state is never cached (Decision 1). Failed mutations revalidate nothing. The 60-second TTL doubles as the invalidation path for ingestion writes, which arrive from Actions and can only wait out the window.

## Decision 3 — Revive Dates after a cache hit

`unstable_cache` serializes through JSON, so on a cache hit every `Date` field comes back as an ISO string while still typed as `Date`. This is exactly the "mock passed, real contract broke" failure class from AGENTS.md §9, caught here by reading the contract first: `rankMissions()`'s newest-sort calls `.getTime()` on `publishedAt`, and date rendering expects real Dates. Every timestamp column in this schema is named `*At`, so `reviveDates()` in the wrapper revives by key suffix — one small function instead of hand-listed field maps. As of the correction below it runs on `cached()`'s RESULT, where it revives strings on hits and passes live Date objects through untouched on misses.

## Correction (2026-08-23, found during this ADR's own live verification)

Decision 3's original placement ran `reviveDates` INSIDE the wrapped callback: `unstable_cache(async () => reviveDates(await read()), ...)`. That placement cannot work, and the tests above couldn't catch it because they mock at the module boundary rather than through Next's cache implementation. `unstable_cache` serializes its callback's return value into the store before the caller sees it — on every request, miss included — so whatever `reviveDates` revived was serialized right back into `"*At"` ISO strings. Every served read carried string dates; the revival was dead code.

Production demonstrated it: `/` served repo cards whose `lastIngestedAt.toLocaleDateString()` threw (`TypeError: ... is not a function`, digest 3114066283), which React turned into error-boundary skeletons that look like slow loading. Reproduced locally with `next start` against dev Neon on the first try; `next dev` never shows it because the data cache is disabled there.

Fix: `cachedRead()` now awaits `cached()` and applies `reviveDates` to its result — outside the serialization boundary, so hits revive and misses pass through. Two regression tests pin the placement (a serializing-cache fake plus assertions on what gets wrapped), and `reviveDates()` itself gained an ISO-shape guard so a non-date `*At`-suffixed string passes through instead of becoming an Invalid Date.

Verification status after the fix: locally, production build against real Neon renders `/` (dates rendered via `toLocaleDateString`) and `/missions` (174 missions) identically on back-to-back requests — miss and 60-second-window hit paths both exercised. Remaining before flipping to Accepted: the same two-request check against the deployed site after this merges.

## What changed

- `app/src/lib/queries/missions.ts` — rewritten: `cachedRead()` helper (key parts + tag + TTL), `reviveDates()`, cached variants of the seven shared reads, doc comment stating the invalidation contract.
- `packages/core/src/db/queries.ts` — `getReposWithMissionSummary` split into exported `getRepoDirectoryBase` + overlay wrapper (no behavior change).
- `app/src/app/api/missions/[id]/claim|unclaim/route.ts`, `api/repos/route.ts`, `api/repos/[id]/withdraw/route.ts` — success-path `revalidateTag` calls.
- Route test suites for those four endpoints — `next/cache` mocked; assertions lock the which-tags-on-which-outcome contract.
- Pages unchanged except imports they already used — same function names, now cached.

## Consequences

- Repeat views of `/missions`, `/`, and repo boards within 60 seconds hit the Vercel Data Cache instead of Neon; the heaviest joins run at most once per minute per key under steady traffic.
- Claims/bookmarks/submissions/withdrawals remain immediately visible everywhere (tag revalidation is platform-wide). Ingestion-driven changes appear within 60 seconds — accepted trade-off, recorded here rather than assumed.
- The cache is keyed by exact filter sets; novel filter combinations simply miss once. No correctness risk — worst case is a miss.
- `unstable_cache`'s serialization contract is now load-bearing; if Next ever changes it, `reviveDates()` is the single place that notices.

## Alternatives considered

| Alternative                                      | Why not                                                                                                                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page-level ISR / `revalidate` exports            | Homepage renders per-user bookmark state and session UI; caching whole pages would leak or fragment per user. Query-layer caching keeps the user-specific slice uncached and tiny.                                      |
| Instance-local TTL `Map` (rate-limit.ts pattern) | Invalidation would be per-serverless-instance: a claim on instance A leaves instances B…n stale up to 60 s, breaking the instant-freshness requirement for the highest-traffic write. `revalidateTag` is platform-wide. |
| React `cache()` alone                            | Per-request dedupe only — no cross-request reuse, which is where the entire win lives.                                                                                                                                  |
| Longer TTL + webhook from ingest workflow        | A new authenticated callback route for data that Mico scoped at 60 s staleness is machinery before need. Revisit if the daily cron's results must be visible faster than the TTL.                                       |

---

_End of document._
