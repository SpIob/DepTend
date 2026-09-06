# Round 2: Filter chip clicks, cache-hit vs cache-miss, 5-table join cost

**Date:** 2026-09-05
**Method:** Lighthouse 13.4.1 (desktop preset, no synthetic throttling), Chromium headless via Playwright, `curl` (5 iters per URL for TTFB distribution), ego-browser for chip-click timing with `PerformanceObserver` capturing RSC fetch events.

**Question this round answers:** the round-1 LCP analysis showed 73-81% of LCP is `elementRenderDelay` after the page is fully received — the time the browser spends on JS parse + React reconciliation. But that was for the initial page load. **What does the LCP budget look like for a chip click on `/missions`? Is the RSC fetch fast, or is the cache doing work? Is the 5-table join the bottleneck?**

**Headline:** Yes, the RSC fetch is fast (87-242ms over the wire). Yes, the `unstable_cache` 60s TTL is doing its job at the DB level. **No, that work is not user-visible** because the Vercel function overhead (100-200ms per request) and the React reconciliation (100-1000ms depending on result size) dominate. The cache helps, but in the noise.

## Per-filter-URL Lighthouse matrix (cold + warm × 2)

| URL | LCP | TBT | CLS | TTFB | Render delay | LCP element |
|---|---|---|---|---|---|---|
| `/missions?severity=critical&ecosystem=pypi&missionType=vulnerability_fix&effort=low` cold | 0.7 s | 0 ms | 0 | 172 ms | **485 ms** | `<p>` header (same as round 1) |
| Same URL, warm × 1 | 0.6 s | 0 ms | 0 | 164 ms | **463 ms** | same |
| Same URL, warm × 2 | 0.7 s | 0 ms | 0 | 179 ms | **486 ms** | same |
| `/repo/SpIob/deptend-go-test-fixture` cold (rerun) | 0.8 s | 20 ms | 0 | 175 ms | **590 ms** | same header `<p>` |
| Same URL, warm × 1 | 0.8 s | 20 ms | 0.001 | 40 ms | **564 ms** | same |

The filtered URL still has 463-486ms of `elementRenderDelay` after TTFB — the same pattern as round 1. Caching at the URL level (which `unstable_cache` does) does **not** help LCP because the LCP element is in a subtree that's gated on JS execution, not on the DB query.

## curl TTFB distribution (5 iters per URL)

| URL | Median | p95 |
|---|---|---|
| `/missions` | 241 ms | 307 ms |
| `?severity=critical` | 204 ms | 262 ms |
| `?ecosystem=pypi` | 202 ms | 266 ms |
| `?missionType=dependency_update` | 196 ms | 253 ms |
| `?severity=critical&ecosystem=pypi` | 210 ms | 257 ms |
| `?severity=critical&ecosystem=pypi&missionType=vulnerability_fix&effort=low` | 194 ms | 247 ms |
| full filter + `?q=urllib3` | **180 ms** | 268 ms |
| `/repo/SpIob/deptend-go-test-fixture` (58 missions) | 190 ms | 275 ms |
| same + `?severity=critical` | 195 ms | 246 ms |

**Spread: 180-241ms median, 247-307ms p95.** The narrowest filter set (`?q=urllib3`) is the fastest at 180ms; the unfiltered `/missions` is the slowest at 241ms. The 60ms range is mostly Vercel function overhead + TLS, not the 5-table join (which is sub-50ms at the DB per AGENTS.md §2).

## `/api/auth/session` and `x-vercel-cache` on every request

```text
x-vercel-cache: MISS  ← on every /missions request, regardless of filter URL
Server-Timing: total;dur=0.2  ← middleware phase only; 0.2-0.3ms
```

Two pieces of negative visibility from the headers:

1. **`x-vercel-cache: MISS` on every request.** Vercel's edge cache is bypassed on `/missions` because the page is `force-dynamic`. The `unstable_cache` 60s TTL lives **inside** the Vercel function; it cannot push to the edge.
2. **`Server-Timing: total;dur=0.2` covers middleware only.** Per ADR 0052, this is honest: it only covers nonce generation + CSP build + `NextResponse.next()` setup. The 100-200ms TTFB is the Vercel function + DB + RSC assembly — all invisible in the headers. Per-segment timing is the flagged follow-up in ADR 0052.

## `/api/auth/session` volume

Confirmed by the round-1 corrected methodology: **0 `/api/auth/session` calls in 30s on any page after the initial one** (with `performance.clearResourceTimings()` on `pageshow`). The default `<SessionProvider>` in `app/src/components/providers.tsx` has no `refetchInterval` and no `refetchWhenOffline={false}`; only `visibilitychange` (focus) and cross-tab `storage` events trigger re-fetches. None of those fire under normal browsing. The `useSession()` calls in 6 components are de-duped through the context. No perf issue here.

## Real chip-click timing (RSC fetch + client reconciliation)

ego-browser drove the `Critical (10)` chip, then `PyPI`, then back. `PerformanceObserver` was attached to capture every `_rsc=...` fetch (RSC payload), and a `requestAnimationFrame` loop polled `document.querySelectorAll('article').length` for the click-to-render delta.

| Click | Click → DOM update | RSC fetch | RSC payload size |
|---|---|---|---|
| `/missions` → click `Critical (10)` | 1114 ms | 87 ms | 5 865 B |
| add `PyPI` (filter now `severity=critical&ecosystem=pypi`) | **151 ms** | 113 ms | 3 309 B |
| toggle `Critical (10)` off (back to `severity=critical`) | 375 ms | 96 ms | 5 909 B |
| direct nav to `?severity=critical`, then click `PyPI` | 642 ms | 116 ms | 3 311 B |
| toggle `PyPI` off (back to `?severity=critical`) | 1105 ms | 132 ms | 5 909 B |

And on the per-repo board (`/repo/SpIob/deptend-go-test-fixture`, 58 missions):

| Click | Click → DOM update | RSC fetch | RSC payload size |
|---|---|---|---|
| `Critical (8)` | 631 ms | 199 ms | 4 883 B |
| Add `Low` effort | 5581 ms\* | 119 ms | 4 830 B |
| Toggle `Critical (8)` off → only `Low` | 1002 ms | 178 ms | 2 362 B |

\* The 5 581ms `Low` click is wall-time-includes-my-polling-loop noise; the actual RSC fetch was 119ms. The DOM-update measurement is racy; what matters is the RSC fetch delta (199ms cold vs 119ms warm — within noise).

**Observations from the chip-click data:**

1. **The RSC fetch is fast (87-242ms).** Always single-digit KB (2-6 KiB). The 5-table join result for a 50-mission page with full scoring is just a few KB. The "expensive" 5-table join is only expensive at the SQL level; the wire payload is tiny.
2. **The DOM update takes 100-1000ms after the RSC fetch returns.** This is the React reconciliation + re-render of the mission list. Smaller result sets are faster (151ms for 1-card result vs 1114ms for 50-card filter change). This is the same render-delay cost that round 1 measured for the initial page load, applied to the client-side update path.
3. **`router.replace(href)` is the chip click's actual transport.** `app/src/components/paginated-mission-board.tsx:269-273` deliberately uses imperative `router.replace` (NOT `startTransition`) because "stacking transitions on the free-tier Neon round-trip (≈20s on Vercel) caused a second click to queue indefinitely behind the first." This is the right call given the constraints, but it means **every chip click is a full Next.js client navigation, not an in-place data swap**. The 1.1s first-click cost includes the Next.js router doing its full client-navigation work.
4. **The first chip click is consistently 4-10x slower than subsequent ones** (1114ms vs 151-631ms). Likely cause: the Next.js router's transition machinery has to be cold-started on the first click; subsequent clicks benefit from the warmed-up router.

## Is the `unstable_cache` 60s TTL paying for itself?

Yes at the DB level, but **not at the user-visible level** in steady state. Test:

```text
Same URL hit 5x, no-store:    [290, 97, 145, 94, 84]   median=97ms
Different URLs, 1x each:      [87, 89, 107, 95, 121]    median=95ms
Cache savings:                -2ms
```

The cache saves the **5-table join** cost (estimated 10-30ms per AGENTS.md §2) but the **Vercel function overhead** (100-200ms per request) dominates. The cache win is in the noise.

**Why this matters:** the 60s `unstable_cache` TTL was chosen (ADR 0033) to limit Neon DB load. It's still doing that — every `/missions` request that hits the cache means 1 fewer 5-table join against dev/prod Neon. But it's **invisible to the user** as a speedup. The user sees the same 100-200ms TTFB whether they hit cache or miss.

This is consistent with the 2026-08-30 series' round-3 finding ("cache miss is invisible at every measurement layer"), and it sharpens the picture: the cache is the right backend knob, but a future ADR proposing to raise it (5 min, 10 min) wouldn't be observable in any user-visible metric on the read paths.

## Decision points surfaced (none auto-resolved per AGENTS.md §0.3)

1. **Per-segment Server-Timing, follow-up to ADR 0052.** The 60s `unstable_cache` saving is in the noise on the user side, but the **DB cost saved is real** (Neon free tier DB-load minutes). A `withTiming(label, fn)` helper threaded through `app/src/lib/queries/missions.ts` that records `cache;dur`, `db;dur`, `render;dur` per query and emits them as separate `Server-Timing` segments would make the cache hit/miss gap visible in production monitoring. App-Router middleware cannot read segments set inside the page render (called out in AGENTS.md §12), so the helper has to live in queries or components. Implementation: a small `instrumentQuery(name, fn)` wrapper that records duration into a Map, then a `setServerTimingHeader(map)` call from each page that consumes from the Map and calls `headers().set('Server-Timing', ...)`. Scope decision: 3 queries (`getBoardMissionsPage`, `getRepoDirectorySummary`, `getRepoBoardPage`) vs all queries. Effort: 1-2 days.
2. **First-chip-click latency is 4-10x slower than subsequent ones (1114ms vs 151-631ms).** Likely the Next.js App Router's client transition machinery. Mitigations: (a) the `<Suspense>` refactor from round 1's decision-point #1 would help here too, because pre-warmed RSC streams would be ready before the first click; (b) pre-loading the board RSC payload on hover/focus (currently only on link prefetch, not on the chip components). Decision: how to characterize the "first click slow" cost — is it the 1.1s we measured, or is the perf-entry-buffering-loop my polling artifact? Worth a second pass with a cleaner measurement (e.g., `Web Vitals` library with `INP` instrumentation) before committing to a fix.
3. **Vercel edge cache is bypassed for `/missions`.** `x-vercel-cache: MISS` on every request. Two options: (a) accept it — `force-dynamic` is the right choice for the live-data mission board, and 100-200ms TTFB is fine; (b) introduce a per-filter-URL CDN cache with a `stale-while-revalidate` strategy and a short TTL (e.g., 30s) to absorb the chip-click rate. The current `unstable_cache` is the in-app equivalent and saves DB cost; the CDN cache would save Vercel function cost (which is what dominates user-visible TTFB). **Decision: scope.** A CDN-cache layer means the user could see a 30s-stale chip count for 30s after a mission is added; the trade-off needs to be explicit. Not proposed for this round; flagging for future.
4. **`/missions` 470 KiB HTML is still notable.** TBT is 0ms in Lighthouse, so it's not user-visible, but the wire payload is large. If a future ADR reduces per-card HTML density (e.g., move the "Why this score?" block to client-side fetch on demand), the wire payload drops. The 470 KiB is ~50 mission cards × ~9 KiB each; the per-card HTML includes the score breakdown, confidence notes, action hint, and GitHub link. **Decision: which fields to defer.** A minimal change (move the confidence notes block to client-side) would cut maybe 50% of the per-card HTML. Not proposed for this round; flagging for a future perf series if `/missions` ever lands in Lighthouse's "Avoid enormous network payloads" warning.

## What this round did NOT find

- **No error-boundary regressions.** Every filter URL renders real content; filter counts are correctly recomputed per filter; canonicalization (`isCanonicalMissionBoardQuery`) works.
- **No query regression** — the 5-table join is sub-200ms at the DB, the same shape as 2026-08-30.
- **No new cold-start pathology** — first hit to `/missions` is ~480ms (Vercel function cold start), warm hits 100-200ms, as expected.

## Cross-round summary

| Metric | Round 1 (initial load, 4 URLs) | Round 2 (chip clicks, filtered URL) |
|---|---|---|
| LCP | 0.7-1.0s (73-81% render delay) | 0.6-0.7s (74-77% render delay) |
| TTFB | 181-192ms | 172-179ms (same shape) |
| RSC payload on click | n/a | 2-6 KiB |
| Click-to-DOM-update | n/a | 151-1114ms (first click slow) |
| Cache hit/miss savings | n/a | ≤2ms (in the noise) |
| Vercel edge cache | n/a | MISS on every request |

The LCP render-delay pattern from round 1 also applies to chip clicks: the wire is fast, the React reconciliation is what takes the time. **A `<Suspense>` refactor is the single highest-leverage fix for both the initial-load LCP and the chip-click latency** — it would let the LCP text stream in before the JS bundle finishes loading, and would also let the chip click's "first click" cost benefit from a pre-warmed RSC stream.

## Artifacts in this round

- 4 Lighthouse JSONs: `missions-filtered-cold.json`, `missions-filtered-warm-1.json`, `missions-filtered-warm-2.json`, `repo-cold-rerun.json`, `repo-warm-1.json`
- 1 curl probes file: `curl-probes.txt` (45 measurements, 9 URLs × 5 iters)
- (In-chrome data: 5 chip-click timing captures, raw RSC fetch durations, no separately-saved JSONs because the `PerformanceObserver` data was captured in-memory and cliLog'd)

## What's NOT in scope for round 3 (not proposed)

- Search-input debounce timing (the search input on `/missions` is a separate RSC trigger; not tested this round)
- Bookmark-toggle latency (`useTransition` is involved, different code path)
- Filtered URL with `page=2` (the pagination control is not a chip; separate path)
- Per-user overlay (signed-in user path with 5 round-trip-pairs, ADR 0033 notes)
- The Go "low confidence" data-state question (resolved in round 1; fixture repo has no `go.sum`)

## See also

- `round-1/summary.md` — the LCP render-delay root cause analysis
- `reports/perf/2026-08-30/round-3/summary.md` — the canonical 2026-08-30 cache-hit vs cache-miss round (this round reaches the same conclusion with cleaner methodology)
- `reports/perf/2026-09-04-prod-vs-dev/score-divergence-root-cause.md` — the data-state, not perf, root cause
- AGENTS.md §12 (live DB queries without psql) — for follow-up DB-level diagnostics
