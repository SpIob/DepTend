# Round 1: Cold-cache baseline — anonymous

**Date:** 2026-08-30
**Goal:** Establish the cold-cache performance floor for the four public pages of `deptend.vercel.app` as an anonymous viewer. This round measures the first request after cache eviction; subsequent rounds compare to this.

**Method:**

- Lighthouse 13.4.1 (desktop preset, no synthetic throttling, `throttling-method=provided`).
- Chromium headless via Playwright (`/Users/spiob/Library/Caches/ms-playwright/chromium_headless_shell-1234`).
- Each page measured in its own fresh `user-data-dir` with `--disable-cache --disk-cache-size=1` to defeat both the browser disk cache and any intermediate proxy cache; this is the closest analogue to "first request after a CDN edge cache miss" that the lab tool can produce.
- Parallel execution where possible (4 cold runs in flight at once) to keep wall time low; the four pages do not share state.
- 5x `curl` probes per page (5 iters) to confirm Lighthouse's "Root document" time and to surface end-to-end TTFB including TLS+connect to the Vercel edge.
- ego-browser visual check: one navigation per page to confirm none serve an error-boundary skeleton (per AGENTS.md §13's known `/missions` and `/` regressions).

**URLs tested:**

| Page | URL | Notes |
|---|---|---|
| Home | `https://deptend.vercel.app/` | The repo directory (ADR 0027). |
| Missions board | `https://deptend.vercel.app/missions` | Default sort/filter, page 1. |
| Org directory | `https://deptend.vercel.app/org/SpIob` | A real org in the directory; ADR 0047 live. |
| Repo detail | `https://deptend.vercel.app/repo/psf/requests` | One of the two repos flagged in ADR 0047 as >50 missions. |

## Lighthouse metrics (cold)

| Page | FCP | LCP | TBT | CLS | Speed Idx | Doc TTFB (LH) | Perf score | Page bytes |
|---|---|---|---|---|---|---|---|---|
| `/` | 0.8 s | 1.1 s | 20 ms | 0.033 | 0.9 s | 40 ms | 97/100 | 141 KiB |
| `/missions` | 0.6 s | 1.0 s | 10 ms | 0 | 0.8 s | 40 ms | 99/100 | 155 KiB |
| `/org/SpIob` | 0.4 s | 0.8 s | 40 ms | 0.038 | 0.5 s | 40 ms | 100/100 | 138 KiB |
| `/repo/psf/requests` | 0.6 s | 1.0 s | 10 ms | 0 | 0.8 s | 40 ms | 99/100 | 164 KiB |

## curl TTFB probes (5 iters per page)

| Page | Median TTFB | TTFB range | Median total | Median bytes |
|---|---|---|---|---|
| `/` | 172 ms | 161-215 ms | 187 ms | 34 061 |
| `/missions` | 178 ms | 172-203 ms | 260 ms | 478 299 |
| `/org/SpIob` | 192 ms | 177-227 ms | 208 ms | 15 525 |
| `/repo/psf/requests` | 183 ms | 170-193 ms | 264 ms | 450 408 |

## Observations

1. **Vercel edge is the dominant cold-path cost.** Lighthouse's `server-response-time` audit consistently reports 40 ms (the time from request initiation to first byte received). `curl` adds 130-180 ms on top of that for TLS+connect+HTTP/2 setup. The actual server render is fast.

2. **Lighthouse "TTFB" is not full TTFB.** Lighthouse measures from the moment the *browser* starts the request, excluding connection setup. The ~150 ms gap between LH's 40 ms and curl's 180 ms is the Vercel edge / TLS handshake. For end-to-end latency against a real user this is what matters, not the LH number.

3. **Server render is the same on every page (~200 ms total).** The fact that `/missions` (478 KiB response) and `/org/SpIob` (15 KiB response) have nearly identical server render time is consistent with the AGENTS.md §2 model: these are all `force-dynamic` Server Components, the page is assembled server-side from a small number of bounded SQL queries, and the byte cost of the response is dominated by hydration payload (mission cards, repo cards) — not the server work.

4. **The homepage CLS of 0.033 is real, not noise.** It's small enough to stay under the 0.1 "good" threshold but it's the highest of the four. Likely source: the header chrome rendering first, then the repo-card grid hydrating in. The other three pages are either single-column (the mission board's paginated list) or render a known set of items synchronously (org/repo header data fetched alongside the list).

5. **All four pages render to title in ego-browser:**
   - `/` → "DepTend"
   - `/missions` → "All missions — DepTend"
   - `/org/SpIob` → "Organization: SpIob — DepTend"  ← confirms ADR 0047's org-page fix is live
   - `/repo/psf/requests` → "psf/requests — DepTend"
   No error-boundary skeletons served.

6. **`/org/SpIob` is the cheapest cold path.** Only 4 repos in this org; the directory is small. This will be a useful baseline to compare against `/` (4 repos total, the entire directory) and against a hypothetical org with more repos.

7. **The homepage's distinct-ecosystem scan — flagged in AGENTS.md §13 as potentially seq-scan-bottlenecked** — does not appear to surface as a Lighthouse cold-path problem on this dataset. With only 4 repos the planner doesn't have a strong reason to choose seq-scan over index-scan even without `idx_dependencies_repo_ecosystem` (migration 0005). Round 2 (warm) will tell us if the 60 s cache is masking something.

## What's coming

- **Round 2 (warm-cache hit rate)** — 3 warm runs per page back-to-back. This is the actionable steady-state number; if warm TTFB drops to single-digit ms, the `unstable_cache` 60 s TTL is doing what ADR 0033 says it should.
- **Round 3 (`/missions` with full filter set + cache-miss forcing query)** — exercises the 5-table join + tally under realistic filter load and forces cache misses via a unique `?q=` token per request.
- **Round 4 (`/repo/[owner]/[name]` for `SpIob/deptend-go-test-fixture`, 55 missions)** — the larger of the two repos flagged in ADR 0047; tests the `LIMIT 1000` per-repo board path.
- **Round 5 (`/org/[org]` for a populated org cold + warm)** — the page that was a permanent loading skeleton until 2026-08-29.
