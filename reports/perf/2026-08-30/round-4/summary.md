# Round 4: `/repo/[owner]/[name]` for a large repo

**Date:** 2026-08-30
**Goal:** Test the per-repo mission board's `LIMIT 1000` path (ADR 0047's recent fix) with the largest repo in the directory. This is the largest single-page payload in `/app` and the path that was hard-truncated at `BOARD_PAGE_SIZE` (50) before ADR 0047.

**Method:**

- Test repo: `SpIob/deptend-go-test-fixture`. Confirmed 55 open missions on the page (counted from the 55 `osvId` occurrences in the HTML; this matches the "55 missions" figure called out in ADR 0047 as the larger of the two repos that exposed the pre-0047 truncation bug).
- Lighthouse cold (1 run) + warm (3 runs) at desktop preset.
- Reference repo: `psf/requests` (51 missions, also > BOARD_PAGE_SIZE, second of the two repos in ADR 0047) for cold comparison only.
- 10x `curl` probes for each repo to characterize TTFB distribution.

## Mission counts and response sizes

| Repo | Mission count | Response size | Pre-ADR-0047 behavior |
|---|---|---|---|
| `SpIob/deptend-go-test-fixture` | 55 | 549 644 bytes | Truncated to 50 |
| `psf/requests` | 51 | 450 408 bytes | Truncated to 50 |
| `SpIob/Bagong-Enerhiya` | (very few — page is 23 KiB) | 23 391 bytes | Under truncation threshold |
| `SpIob/FlowState` | (similar) | (not measured) | Under truncation threshold |

## Lighthouse metrics

| Run | FCP | LCP | TBT | CLS | Doc TTFB (LH) | Perf score | Page bytes |
|---|---|---|---|---|---|---|---|
| `deptend-go-test-fixture` cold | 0.4 s | 0.8 s | 60 ms | 0.001 | 40 ms | 99/100 | 165 KiB |
| `deptend-go-test-fixture` warm-1 | 0.4 s | 0.9 s | 50 ms | 0 | 40 ms | 99/100 | 165 KiB |
| `deptend-go-test-fixture` warm-2 | 0.4 s | 0.8 s | 40 ms | 0 | 40 ms | 99/100 | 165 KiB |
| `deptend-go-test-fixture` warm-3 | 0.4 s | 0.8 s | 50 ms | 0 | 40 ms | 100/100 | 165 KiB |
| `psf/requests` cold | 0.4 s | 0.8 s | 40 ms | 0 | 40 ms | 99/100 | 164 KiB |

## curl TTFB probes (10 iters each)

| Repo | Median TTFB | TTFB range | Median total | Median bytes |
|---|---|---|---|---|
| `deptend-go-test-fixture` (55 missions) | 184 ms | 170-220 ms | 271 ms | 549 644 |
| `psf/requests` (51 missions) | 198 ms | 170-278 ms | 281 ms | 450 408 |
| `Bagong-Enerhiya` (very few) | 195 ms | 178-203 ms | 203 ms | 23 391 |

## Observations

1. **All 55 missions render correctly.** This is the headline: the ADR 0047 `LIMIT 1000` fix is live in production. The page's HTML contains 55 distinct `osvId` references; the page is 549 KiB, which is consistent with 55 mission cards each containing the full mission detail (severity, package, repo, description, claim/dismiss controls). Pre-0047, this page would have served a 50-card version, identical-looking but missing 5 missions, and users would have had no way to discover them.

2. **Page weight is dominated by the mission cards, not the server work.** Lighthouse reports the *transferred* page bytes at 165 KiB (compressed) for both repos — the 549 KiB / 450 KiB / 23 KiB response sizes are the *uncompressed* HTML that `curl` reports. The compression ratio is ~3-3.3x, which is what you'd expect for highly repetitive mission-card markup. The compressed transfer is the same order of magnitude as every other page (141-165 KiB).

3. **TBT jumps to 40-60 ms for the large repo**, vs 10-30 ms for `/missions` (which also has 50 cards but includes the filter chip bar). This is the cost of mounting 55 client `MissionCard` components on first paint. Still well under the 200 ms "good" threshold, but it's the only metric that scales noticeably with mission count.

4. **TTFB is identical regardless of mission count.** The 55-mission repo (549 KiB HTML) and the 51-mission repo (450 KiB HTML) have overlapping TTFB ranges. The 5-table join (`queries.ts:500`) is doing essentially the same work in both cases, with the only difference being the row count returned. The DB-side cost is dominated by the join logic, not the row shipping.

5. **Cold vs warm delta is small for the per-repo page.** Cold LCP 0.8 s, warm LCP 0.8-0.9 s. The first request has to assemble the full HTML from a DB query, but the `unstable_cache` 60 s TTL on `getRepoBoardPage` (per `app/src/lib/queries/missions.ts:133`) means subsequent requests within 60 s collapse to a Vercel Data Cache lookup. With 4 repos in the directory and a small number of unique signed-in users, the cache hit rate in production is likely high.

6. **No regression vs Round 2's `/repo/psf/requests` warm numbers.** The 4 warm runs across the two rounds produced identical 0.7-0.8 s LCP and 99-100/100 perf scores. The per-repo page is stable.

7. **`/repo/SpIob/Bagong-Enerhiya` (23 KiB response, very few missions) is the fastest per-repo page.** TTFB range 178-203 ms — within the noise of the others, but `total` time is 197-220 ms (vs 250-345 ms for the mission-heavy pages). The end-to-end latency scales with HTML size on the transfer side, not on the server-render side. The bottleneck is the same as everywhere else: Vercel edge + TLS+connect.

## What this round confirms

- **ADR 0047's `LIMIT 1000` fix is verified live.** The page renders 55 missions (vs the pre-0047 truncation at 50). No error-boundary skeleton, no `notFound()`, just the full board.
- **The per-repo page is not a perf risk at the current data scale.** Even with 55 missions on the page, the LCP stays under 1 s and TBT under 60 ms. The 1000-row upper bound is well within the page's headroom.
- **If a repo ever has 500-1000 missions, the client-side TBT will be the first metric to suffer.** Hydrating 500 `MissionCard` components will push TBT into the 100s of ms. The mitigations are: server-paginate the per-repo board above some threshold, or virtualize the card list client-side. Both are decisions, not bugs, and neither is needed today.

## What's coming

- **Round 5** will revisit `/org/[org]` for SpIob (the only populated org) cold + warm to characterize the page that was a permanent loading skeleton until 2026-08-29. Then the comparison across all 5 rounds.
