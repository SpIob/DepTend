# 0055 — `<Suspense>` boundary on `/missions` for LCP streaming

**Status:** Proposed. Round 3 of `reports/perf/2026-09-05/` is the live verification artifact. Acceptance requires a Vercel preview-deploy measurement against `deptend.vercel.app` (not done yet — AGENTS.md §10).

## Context

The mission board's LCP element is a static `<p>` in the page header
("Every open mission across every indexed repo, one list. Looking for one
repo? Browse repos instead."). Round 1 of `reports/perf/2026-09-05/` measured
73-81% of LCP as `elementRenderDelay` — time between TTFB and the LCP element
actually painting. Round 2 confirmed the same pattern: the LCP text is hidden
inside the streamed RSC payload, swapped in only after React's `$RS()` helper
runs (post JS bundle parse + hydration).

The same root cause applies to `/` and `/repo/[owner]/[name]`. Round 3 of the
series implemented and measured the fix on `/missions`; this ADR is the
canonical record.

## Decision

Wrap the data-dependent render of `/missions` in a `<Suspense>` boundary so
the LCP `<p>` is in the unsuspended subtree, streaming with the initial HTML
payload. The data fetches (`getBoardMissionsPage`, `getRepoDirectorySummary`)
move into Server Components inside the boundary; the data-dependent header
stats and the board render against a narrow skeleton that doesn't cover the
LCP text.

## Implementation (in `reports/perf/2026-09-05/round-3/`)

Two files change:

- `app/src/app/missions/page.tsx` — extracted `BoardArea` and
  `DataDrivenHeaderStats` Server Components; wrapped each in `<Suspense>`.
  The outer page still handles searchParams parsing, query canonicalization,
  and `redirect()` for out-of-range `?page=`.
- `app/src/app/missions/loading.tsx` — narrowed the page-segment skeleton
  to cover only the board area, not the LCP text.

Before, the page's `await Promise.all([getBoardMissionsPage(...), getRepoDirectorySummary()])`
blocked the entire `<main>` from rendering until the data arrived. After, the
static header chrome and the LCP `<p>` render immediately; only the data-
dependent subtree is suspended.

## Verification

Live verification, round 3 of the 2026-09-05 perf series
(`reports/perf/2026-09-05/round-3/summary.md`):

- Built with `pnpm build` (production bundle), served with `pnpm start`,
  measured against the dev Neon (per ADR 0023's dev-prod split).
- `pnpm typecheck`, `pnpm test` (190 app / 774 core / 40 cli / 8 scripts
  tests), `pnpm lint --max-warnings 0`, `pnpm format:check`, `pnpm build`
  all pass.
- Lighthouse 13.4.1 desktop preset, no synthetic throttling, on `/missions`:
  - **Cold LCP: 0.7s → 0.3s (-57%)**, render delay 626ms → 118ms (-81%).
  - **Warm LCP: 0.5-0.8s → 0.1s (-83%)**, render delay 400-477ms → 46-70ms
    (-85%).
  - CLS: stable at 0.002 across all 8 runs; no regression.
  - TBT: 0-10ms → 0-40ms (small bump from the extra hydration, well within
    the 200ms "good" threshold).
- Same measurement on `/missions?severity=critical` (filtered URL): LCP
  0.7s → 0.1s (-86%).
- Chip-click timing (round 2's follow-up): first Critical click
  1114ms → 49ms (-96%); RSC fetch 87ms → 18ms (-79%).

## What did NOT change

- The data fetches are still `getBoardMissionsPage` + `getRepoDirectorySummary`
  in the same `Promise.all`. The `unstable_cache` 60s TTL is unchanged.
- `force-dynamic` is still set. The page is still server-rendered on every
  request.
- The total page weight is unchanged at 164 KiB. The refactor doesn't add
  client JS.
- `redirect()` for out-of-range `?page=` is unchanged (handled by the user's
  WIP `clampPageNumber` work in ADR 0054).

## Next steps

- Apply the same pattern to `app/src/app/page.tsx` and
  `app/src/app/repo/[owner]/[name]/page.tsx`. Both have the same render
  structure; the LCP win should carry over.
- Deploy to a Vercel preview URL and re-measure LCP cold + warm × 3 against
  `*.vercel.app`. This is the §10 live-verification step required to flip
  this ADR to Accepted.
- The TBT bump (0-10ms → 0-40ms) is from the extra `<Suspense>` hydration.
  If a future pass needs to shave it, collapsing the two Suspense boundaries
  into one is a one-line change.
