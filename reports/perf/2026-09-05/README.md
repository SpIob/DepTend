# Performance series 2026-09-05

Mirror of the 2026-08-30 series' shape, run a day after the 2026-09-04 prod-vs-dev comparison.

## What's here

- `round-1/` — cold + warm × 3 baseline across the four smoke URLs (`/`, `/missions`, `/org/SpIob`, `/repo/SpIob/deptend-go-test-fixture`). Full Lighthouse JSONs + screenshots + curl TTFB + analysis. **Headline finding: 73-81% of LCP is "element render delay" caused by the `force-dynamic` + no-`<Suspense>` pattern.** See `round-1/summary.md` for the breakdown and the proposed ADR for the refactor.
- `round-2/` — `/missions` chip-click timing (RSC fetch + client reconciliation), 5-table join cost across 9 filter URLs, cache-hit vs cache-miss savings. **Headline finding: the 60s `unstable_cache` saves the 5-table join cost but the saving is ≤2ms in user-visible TTFB; the Vercel function overhead (100-200ms) and React reconciliation (100-1000ms) dominate.**
- `round-3/` — implementation + live verification of the round-1 `<Suspense>` refactor on `app/src/app/missions/page.tsx`. **Headline finding: LCP drops from 0.7s → 0.3s cold (–57%) and 0.6s → 0.1s warm (–83%); first chip click drops from 1114ms → 49ms (–96%). CLS stable at 0.002. The hypothesis is verified.** See `round-3/summary.md` for the before/after data, the refactor design, and the proposed ADR text.
- `round-4/` — **NEGATIVE RESULT**. Attempted the same `<Suspense>` refactor on `app/src/app/page.tsx` and `app/src/app/repo/[owner]/[name]/page.tsx`. **No LCP improvement; CLS regressed from 0/0.002 to 0.029 on both pages.** Refactor was reverted in the same session. The pattern from round 3 only works on pages whose outer render doesn't await network calls before producing JSX. The home and per-repo pages both `await getServerSession(...)` (and `/repo/...` also `await getRepoByOwnerAndName(...)`) in the outer render, so the page-segment `loading.tsx` skeleton is what the browser sees until those awaits resolve. The `<Suspense>` boundary inside the page can only stream content that the outer render has produced. **Decision point raised for round 5**: move `getServerSession` out of the outer render (deeper restructure touching the auth flow; AGENTS.md §0.3).
- `round-5/` — implementation + verification of the per-segment `withTiming()` helper and per-request store. **Headline finding: the helper is built, tested, and the per-segment data is captured (5-table join = 25.8ms, cache lookup = 15.5ms, etc.) — but it lands in stdout, not in a `Server-Timing` header.** AGENTS.md §12 is the constraint: `next/headers`'s `headers()` is sealed read-only in App Router, and middleware runs before the page render, so it cannot read page-render state on the way out. The data is in a per-process `Map<requestId, TimingStore>`; a `setImmediate` flush emits it via stdout (one JSON line per request, two passes — `page-done` and `full`). 8 new unit tests pass; `pnpm typecheck` + `pnpm test` + `pnpm lint` + `pnpm format:check` + `pnpm build` all pass. **Decision points raised**: wire into `/` and `/repo/...` (same pattern, low risk); replace stdout with a metrics endpoint when one exists; per-statement SQL timing if the join ever becomes the bottleneck.

## Decision points surfaced (none auto-resolved)

1. **LCP `<Suspense>` refactor — ROUND 3 VERIFIED.** Implemented on `app/src/app/missions/page.tsx` (only); `app/src/app/page.tsx` and `app/src/app/repo/[owner]/[name]/page.tsx` are the next two to apply. LCP win 400-500ms locally. **Next step per AGENTS.md §10: deploy to a Vercel preview URL and re-measure before flipping the ADR to Accepted.** Scope: same PR as round 3 vs follow-up.
2. **Per-segment Server-Timing** — ADR 0052 follow-up to surface cache/DB/render timings separately. Round 2 sharpened the case: the `unstable_cache` 60s TTL is invisible in user-visible TTFB but the DB-cost savings are real (every cache hit = 1 fewer 5-table join on the free-tier Neon). A `withTiming()` helper + `headers().set('Server-Timing', ...)` from each page would make the cache hit/miss gap visible in production monitoring.
3. **AGENTS.md §6/§9 note** — add the `performance.clearResourceTimings()` gotcha to the perf-testing discipline section, alongside the `reviveDates`-placement note in §12.
4. **Vercel edge cache for `/missions`** — `x-vercel-cache: MISS` on every request; the 60s `unstable_cache` is in-app only. A short-TTL CDN cache (e.g., 30s SWR) would save Vercel function cost (the user-visible 100-200ms overhead) but at the cost of up to 30s of staleness on filter chip counts. Trade-off needs to be explicit; not proposed for this round.
5. **`/missions` 470 KiB HTML payload** — TBT is 0ms in Lighthouse so it's not user-visible today, but per-card HTML density could be reduced (defer "Why this score?" block to client-side fetch) if the page ever lands in Lighthouse's "Avoid enormous network payloads" warning. Not proposed for this round.
6. **Round 3 follow-up: extend the refactor to `/` and `/repo/[owner]/[name]`.** Same pattern, same expected LCP win. Decision: same PR as round 3, or follow-up. **ROUND 4 ANSWERED THIS: no.** The round-3 pattern doesn't carry over because the home and per-repo pages' outer render awaits `getServerSession` (and `getRepoByOwnerAndName` for the repo page) — Next.js's page-segment loading skeleton occupies the visible `<main>` until those awaits resolve, regardless of any `<Suspense>` boundary inside the page. A real fix needs to move the session fetch out of the outer render (decision point raised; AGENTS.md §0.3).
7. **Move `getServerSession` out of the page outer render (NEW, raised by round 4).** Touches every page that uses `getServerSession` (all three: `/`, `/missions`, `/repo/...`). Effort: 1-2 days. Risk: medium (auth is a security boundary). A cookie-based session check at request time is the lighter alternative (½ day, same risk profile). Decide: is the 0.3-0.4s warm LCP on `/repo/...` worth the auth-flow risk, or is it "good enough" (well under the 2.5s threshold)?

## How to reproduce

```bash
# See round-1/summary.md §"How to reproduce" for the full commands.
# All artifacts (4 cold + 12 warm Lighthouse JSONs, 4 screenshots, curl probes) are in round-1/.
```

## See also

- `reports/perf/2026-08-30/` — the canonical series this mirrors.
- `reports/perf/2026-08-30/round-5-fixed/summary.md` — the 2026-08-30 fix for `/org/[org]`.
- `reports/perf/2026-09-04-prod-vs-dev/summary.md` — the prod-vs-dev score divergence root cause (data state, not code).
- AGENTS.md §12 (live DB queries without shelling out to psql) — for follow-up DB-level diagnostics.
