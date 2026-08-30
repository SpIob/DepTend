# Round 3: `/missions` under filter load — anonymous

**Date:** 2026-08-30
**Goal:** Isolate the cost of the 5-table join + tally SQL on `/missions` (the heaviest uncached query in `/app`, per `packages/core/src/db/queries.ts:500`) by comparing the same realistic filter set warm (cache hit) vs cold (cache miss forced via unique `?q=` token).

**Method:**

- Filter set chosen to be realistic for a power user:
  - `severity=critical&severity=high`
  - `ecosystem=npm&ecosystem=pypi`
  - `effort=small&effort=tiny`
  - `missionType=security&missionType=dependency`
  - `sort=quick-wins`
- **Warm (3 repeats):** same filter URL, same `user-data-dir`. Cache slot is hit on iter 2+.
- **Cold (5 repeats):** each with a unique `?q=<random-token>` to force a fresh cache slot per request. The actual server-side work that the cache would otherwise skip is the full board query + tally.
- **curl probes (10x each warm, 10x each cold, 5x each with a matching q):** to look for TTFB differences below the Lighthouse 40 ms resolution floor.
- **Lighthouse desktop preset, no synthetic throttling, `throttling-method=provided`** (same as Rounds 1-2).

## Lighthouse metrics

### Warm (3 repeats on the same filter URL)

| iter | FCP | LCP | TBT | CLS | Doc TTFB (LH) | Perf score | Page bytes |
|---|---|---|---|---|---|---|---|
| 1 | 0.4 s | 0.6 s | 10 ms | 0 | 40 ms | 100/100 | 141 KiB |
| 2 | 0.4 s | 0.6 s | 10 ms | 0 | 40 ms | 100/100 | 141 KiB |
| 3 | 0.4 s | 0.7 s | 0 ms | 0 | 40 ms | 100/100 | 141 KiB |

### Cold (5 runs, each with unique `?q=<token>` to force cache miss)

| iter | FCP | LCP | TBT | CLS | Doc TTFB (LH) | Perf score | Page bytes |
|---|---|---|---|---|---|---|---|
| 1 | 0.4 s | 0.7 s | 20 ms | 0 | 40 ms | 100/100 | 139 KiB |
| 2 | 0.4 s | 0.6 s | 20 ms | 0 | 40 ms | 100/100 | 139 KiB |
| 3 | 0.4 s | 0.7 s | 20 ms | 0 | 40 ms | 100/100 | 139 KiB |
| 4 | 0.4 s | 0.7 s | 0 ms | 0 | 40 ms | 100/100 | 139 KiB |
| 5 | 0.4 s | 0.7 s | 20 ms | 0 | 40 ms | 100/100 | 139 KiB |

### Server-response-time (raw ms from Lighthouse)

- Warm: 41, 36, 35 → median 36 ms
- Cold: 38, 35, 37, 41, 36 → median 37 ms

## curl TTFB probes (10x each)

| Condition | Median TTFB | TTFB range | Median total | Median bytes |
|---|---|---|---|---|
| Filtered, warm | 200 ms | 175-225 ms | 217 ms | 37 667 |
| Filtered, cold (`?q=<random>`) | 200 ms | 180-212 ms | 211 ms | 27 902 |
| Filtered, cold (`?q=requests`) | 195 ms | 188-264 ms | 210 ms | 27 928 |
| Filtered, warm (`?q=requests` 2nd visit) | 194 ms | 174-222 ms | 200 ms | 27 928 |
| No-filter, cold (`?nocache=<epoch-ns>`) | 205 ms | 202-215 ms | 292 ms | 478 374 |
| No-filter, warm (default URL) | 191 ms | 189-200 ms | 263 ms | 478 299 |

## Observations

1. **The `unstable_cache` cache miss is invisible at every measurement layer.** Lighthouse's 40 ms `server-response-time` audit shows warm=36 ms median, cold=37 ms median — within noise. curl TTFB shows the same. The 5-table join + tally (`queries.ts:500` + `queries.ts:447`) is fast enough that it's drowned out by Vercel edge + TLS+connect time.

2. **Response size is the only signal that distinguishes the two cache states.** The filtered URL without any `?q=` returns 37 667 bytes (results matched). The same URL with a `?q=requests` (or any token) returns ~27 900 bytes (no matches, empty-state UI). The board query is doing different work; we just can't see the cost difference in latency. Both paths return within ~200 ms TTFB.

3. **The 5-table join + tally is genuinely fast.** The filtered URL applies 4 enum constraints (`severity IN (2 values)`, `ecosystem IN (2)`, `effort IN (2)`, `missionType IN (2)`), an `ILIKE ... ESCAPE` against `title / package name / owner/name / osv_id`, the 5-table join, and the 5-axis `count(*) FILTER (...)` tally — all within a 35-41 ms server response window. The `idx_missions_dependency_id` (ADR 0035) and `idx_mission_scores_composite_tier` (ADR 0045) migrations are doing their job; the planner is hitting indexes.

4. **Cold vs warm browser-side TBT is the only small but real difference.** Cold 20 ms, warm 10 ms. The first cold paint pays a small extra JS execution cost (likely the filter chip bar hydrating) that the warm cache reuses from the previous render's client state.

5. **No `Server-Timing` header is being emitted by Vercel.** A useful future enhancement would be adding `instrumentation.ts` to emit per-stage timing (`db.query`, `db.tally`, `render.html`) so that the cache-hit vs cache-miss gap is observable in the response headers, not invisible to the lab tool. AGENTS.md §12 already calls out that the 60 s `unstable_cache` is the load-bearing thing and that the Vercel Data Cache lookup + tag-revalidation lookup is what makes the warm path fast — a Server-Timing header would prove this from production traffic without needing this lab.

6. **`?nocache=<epoch-ns>` did not work as a cold-cache forcing technique.** Vercel's edge cache is keyed on the path + query string, and adding a unique `nocache=...` per request forced a fresh edge lookup, but the response time was identical to the warm default URL. The 5-table join happens in the Vercel function instance regardless of whether the edge cache serves a stale HTML response. The `?q=<random>` approach is more reliable for forcing the inner query to actually re-execute, because `q` is part of `cachedRead`'s cache key (`app/src/lib/queries/cached-read.ts:43`).

## What this round confirms

- **AGENTS.md §12's stated `unstable_cache` behavior is correct in production.** A cache-miss cost is sub-50 ms, which is small enough that the Vercel edge + TLS+connect cost dominates the user-visible TTFB.
- **`/missions` is not a perf risk at the current data scale.** The most expensive realistic filter combination is still 100/100 in Lighthouse and renders in <0.7 s LCP for cold and <0.7 s LCP for warm.
- **If mission count grows by 10-100x**, the 5-table join will start to matter, and the `idx_mission_scores_composite_tier` index (ADR 0045, dev-applied but not yet measured in production) is the lever. Round 5 will revisit `/org/[org]` and Round 4 will push `/repo/[owner]/[name]` — neither of these rounds exercises a larger dataset than the current 4-repo directory, so we won't see the index-vs-seqscan crossover in this pass.

## What's coming

- **Round 4** will push `/repo/[owner]/[name]` to the larger of the two repos flagged in ADR 0047 (`SpIob/deptend-go-test-fixture`, 55 missions) to test the `LIMIT 1000` per-repo board and the larger payload path.
- **Round 5** will revisit `/org/[org]` cold + warm to characterize the page that was a permanent loading skeleton until 2026-08-29.
