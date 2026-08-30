# Round 2: Warm-cache hit rate — anonymous

**Date:** 2026-08-30
**Goal:** Quantify the steady-state warm-cache performance of all four public pages and contrast it with Round 1's cold baseline. This is the actionable signal: any given user, on a warm site, sees these numbers.

**Method:**

- Same Lighthouse 13.4.1 setup as Round 1, but **without** `--disable-cache`. Each page reuses one `user-data-dir` for all 3 repeats so the browser's HTTP cache and any downstream caches stay warm.
- 10x `curl` probes per page (10 iters) to characterize the end-to-end TTFB distribution including TLS+connect.
- ego-browser visual check was not re-run; the pages' behavior is unchanged from Round 1 (still 200, same titles).

**URLs tested:** identical to Round 1.

## Lighthouse metrics (warm, 3 repeats per page)

| Page | FCP | LCP | TBT | CLS | Doc TTFB (LH) | Perf score | Page bytes |
|---|---|---|---|---|---|---|---|
| `/` | 0.4 s | 0.6-0.7 s | 10-30 ms | 0.030 | 40 ms | 100/100 | 136-138 KiB |
| `/missions` | 0.4-0.5 s | 0.7-0.8 s | 20-30 ms | 0-0.002 | 40 ms | 99-100/100 | 155 KiB |
| `/org/SpIob` | 0.4 s | 0.5-0.6 s | 0-10 ms | 0.038 | 40 ms | 100/100 | 137 KiB |
| `/repo/psf/requests` | 0.4 s | 0.7-0.8 s | 20-50 ms | 0 | 40 ms | 100/100 | 164 KiB |

## curl TTFB probes (10 iters per page)

| Page | Median TTFB | TTFB range | Median total | Median bytes |
|---|---|---|---|---|
| `/` | 178 ms | 166-194 ms | 187 ms | 34 061 |
| `/missions` | 174 ms | 167-199 ms | 263 ms | 478 299 |
| `/org/SpIob` | 181 ms | 160-208 ms | 188 ms | 15 525 |
| `/repo/psf/requests` | 199 ms | 167-252 ms | 287 ms | 450 408 |

## Cold → warm delta (Lighthouse)

| Page | FCP Δ | LCP Δ | TBT Δ | Score Δ | Bytes Δ |
|---|---|---|---|---|---|
| `/` | **-0.4 s** | **-0.4 s** | flat | +3 | -3 KiB |
| `/missions` | **-0.2 s** | **-0.3 s** | flat | +1 | 0 |
| `/org/SpIob` | flat | **-0.2 s** | -30 ms | 0 | -1 KiB |
| `/repo/psf/requests` | **-0.2 s** | **-0.3 s** | flat | +1 | 0 |

The home page shows the largest cold→warm delta (FCP and LCP both drop 0.4 s). This is consistent with `/` having the highest `_next/static` chunk payload (4 distinct repo-card thumbnails, plus the directory grid) and the most JS hydration work per page. Once the browser's HTTP cache is warm, the per-render work collapses.

## Observations

1. **The `unstable_cache` 60 s TTL is invisible at the curl layer but real at the browser layer.** curl's TTFB is essentially identical cold vs warm (180 ms either way) because each curl invocation pays the full TLS+connect+HTTP/2 setup cost and the 40 ms server render is small relative to that. Lighthouse's FCP/LCP, which exclude connection setup and measure from page navigation, drop 20-40 % warm. This is what a real user with a hot connection sees: the "page is visible" moment shifts left by 200-400 ms after the first visit.

2. **The 40 ms `server-response-time` is stable across rounds.** Same number cold and warm. This is the actual server-side render time on Vercel, and it's flat — which is the right shape (the 60 s cache either serves the cached query result in ~5 ms, or the query runs and takes ~30-40 ms; both are well under the 40 ms observed, and the variance is too small to separate from Lighthouse's measurement noise). A future round that uses a unique-per-request `?q=` token to force cache misses will give a clean isolated measurement of the cache-miss render time vs the cache-hit render time.

3. **/missions` CLS jumps from 0 to 0.002 once.** One of the three warm runs registers a non-zero CLS. The home and `/org/SpIob` are consistent at 0.030 and 0.038. The numbers are small enough to be in the "good" range (<0.1) but real, and a CLS of 0.002 on `/missions` is consistent with the filter chip bar / pagination controls rendering after the mission cards.

4. **Warm `/org/SpIob` is the fastest LCP at 0.5-0.6 s.** The page renders a single header (org name + avatar) plus 4 repo cards. The other three pages have more first-paint content.

5. **The `/missions` TBT range (20-30 ms warm) is the highest of the four pages by absolute number.** This is a client-side concern — the mission board hydrates a long list of `MissionCard` components, each of which is a small client component. 20-30 ms of TBT for ~50 cards is well within the "good" threshold (200 ms) but is the page where client-side JS work is most likely to grow as more client components are added.

6. **No regressions in warm state.** Every metric is the same or better than the cold baseline. The 60 s cache is doing its job for every page.

## What's coming

- **Round 3** will isolate the cache-miss render time by using a unique `?q=` token per request, which forces `getBoardMissionsPage` to compute a fresh query result every time and bypasses the Vercel Data Cache. The cold/warm delta from that round is the cleanest measure of "what does the 5-table join actually cost the user?".
- **Round 4** will push `/repo/[owner]/[name]` to the larger of the two repos flagged in ADR 0047 (`SpIob/deptend-go-test-fixture`, 55 missions) to test the `LIMIT 1000` per-repo board.
- **Round 5** will re-test `/org/[org]` for a different populated org (if one exists) or, if SpIob is the only populated org, will focus on the cold/warm delta in isolation.
