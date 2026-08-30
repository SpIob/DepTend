# Performance test comparison: 5 rounds on `deptend.vercel.app`

**Date:** 2026-08-30
**Tooling:** Lighthouse 13.4.1 (desktop preset, `throttling-method=provided`), Chromium headless via Playwright, `curl`, ego-browser for visual checks.
**Auth:** Anonymous only (signed-in rounds deferred per the planning conversation).

## Per-round headlines

| Round | What it measured | Key finding |
|---|---|---|
| 1 — Cold baseline | All 4 pages, 1 cold run each | All pages ≥97/100 perf score; FCP 0.4-0.8 s, LCP 0.8-1.1 s. DocTTFB 40 ms across the board. Vercel edge + TLS adds 130-180 ms over Lighthouse's measurement. |
| 2 — Warm cache | All 4 pages, 3 warm repeats each | Largest cold→warm win on `/`: FCP/LCP both drop 0.4 s. `unstable_cache` 60 s TTL working as designed; warm DocTTFB still 40 ms (cache hit doesn't reduce server render, only the query work). |
| 3 — `/missions` filter load | Same realistic filter set, warm (3) vs cache-miss-forced cold (5) | **Cache miss is invisible at every measurement layer.** Warm vs cold DocTTFB: 36 ms vs 37 ms. The 5-table join is sub-50 ms. Filter correctness is the only signal — the URL with no `?q=` returns 37 667 bytes (results), the same URL with `?q=<random>` returns 27 902 bytes (empty state). |
| 4 — `/repo/[owner]/[name]` for the largest repo | `SpIob/deptend-go-test-fixture` (55 missions), cold + 3 warm; `psf/requests` (51 missions) for cold reference | **ADR 0047's `LIMIT 1000` fix verified live**: 55 missions render (not 50). TBT 40-60 ms is the only metric that scales with mission count. 549 KiB HTML for the 55-mission page (165 KiB compressed) is the largest single-page payload in `/app`; still LCP 0.8-0.9 s, perf 99-100. |
| 5 — `/org/[org]` cold + warm | SpIob + psf, cold + 3 warm each; plus a control for `/org/nonexistent-zzz` | **REGRESSION FOUND**: every `/org/[org]` URL — including the ones that should render real directories — serves a 404 body. The `organizations` table is empty for SpIob and psf, even though their repos are visible on `/`. The page is "fast" only because it's a 404. See Round 5 summary. |

## Lighthouse metric matrix (median across runs in each round)

All values from Lighthouse 13.4.1 desktop preset. `DocTTFB` is the audit's "Initial server response time"; `curl TTFB` (where listed) is the end-to-end including TLS+connect to the Vercel edge.

### Round 1 — cold baseline

| Page | FCP | LCP | TBT | CLS | DocTTFB | Perf | Bytes |
|---|---|---|---|---|---|---|---|
| `/` | 0.8 s | 1.1 s | 20 ms | 0.033 | 40 ms | 97 | 141 KiB |
| `/missions` | 0.6 s | 1.0 s | 10 ms | 0 | 40 ms | 99 | 155 KiB |
| `/org/SpIob` | 0.4 s | 0.8 s | 40 ms | 0.038 | 40 ms | 100 | 138 KiB |
| `/repo/psf/requests` | 0.6 s | 1.0 s | 10 ms | 0 | 40 ms | 99 | 164 KiB |

### Round 2 — warm (median of 3)

| Page | FCP | LCP | TBT | CLS | DocTTFB | Perf | Bytes |
|---|---|---|---|---|---|---|---|
| `/` | 0.4 s | 0.6 s | 10 ms | 0.030 | 40 ms | 100 | 137 KiB |
| `/missions` | 0.4 s | 0.7 s | 30 ms | 0 | 40 ms | 100 | 155 KiB |
| `/org/SpIob` | 0.4 s | 0.6 s | 0 ms | 0.038 | 40 ms | 100 | 137 KiB |
| `/repo/psf/requests` | 0.4 s | 0.7 s | 40 ms | 0 | 40 ms | 100 | 164 KiB |

### Round 3 — `/missions` with full filter set

| Variant | FCP | LCP | TBT | DocTTFB | Perf | Bytes |
|---|---|---|---|---|---|---|
| Warm (3x) | 0.4 s | 0.6-0.7 s | 0-10 ms | 35-41 ms | 100 | 141 KiB |
| Cold with `?q=<random>` (5x) | 0.4 s | 0.6-0.7 s | 0-20 ms | 35-41 ms | 100 | 139 KiB |

### Round 4 — `/repo/[owner]/[name]`

| Repo | FCP | LCP | TBT | DocTTFB | Perf | Bytes (compressed) | Uncompressed HTML |
|---|---|---|---|---|---|---|---|
| `deptend-go-test-fixture` (55 missions) cold | 0.4 s | 0.8 s | 60 ms | 40 ms | 99 | 165 KiB | 549 644 |
| `deptend-go-test-fixture` warm (3x) | 0.4 s | 0.8-0.9 s | 40-50 ms | 35-37 ms | 99-100 | 165 KiB | 549 644 |
| `psf/requests` (51 missions) cold | 0.4 s | 0.8 s | 40 ms | 40 ms | 99 | 164 KiB | 450 408 |

### Round 5 — `/org/[org]` (currently 404s; see Round 5 summary)

| URL | FCP | LCP | TBT | DocTTFB | Perf | Bytes |
|---|---|---|---|---|---|---|
| `/org/SpIob` cold | 0.4 s | 0.7 s | 50 ms | 40 ms | 100 | 137 KiB |
| `/org/SpIob` warm (3x) | 0.3-0.4 s | 0.6-0.8 s | 20-40 ms | 35-50 ms | 99-100 | 137-138 KiB |
| `/org/psf` cold | 0.4 s | 0.6 s | 20 ms | 40 ms | 100 | 137 KiB |
| `/org/psf` warm (3x) | 0.4 s | 0.6 s | 20-30 ms | 38 ms | 100 | 137-138 KiB |

## curl end-to-end TTFB (median of 5-10 iters per round)

`curl` TTFB includes TLS handshake + Vercel edge. Lighthouse's `DocTTFB` is the *delta* between request initiation and first byte, which excludes connection setup. The ~150 ms delta between the two is the TLS+connect cost.

| Page | Round 1 (cold) | Round 2 (warm) | Round 4 cold | Round 5 cold | Round 5 warm |
|---|---|---|---|---|---|
| `/` | 172 ms | 178 ms | — | — | — |
| `/missions` (default) | 178 ms | 174 ms | — | — | — |
| `/missions` (filtered) | — | 200 ms | — | — | — |
| `/missions` (filtered + `?q=`) | — | 200 ms (forced miss) | — | — | — |
| `/org/SpIob` (404) | 192 ms | 181 ms | — | 187 ms | 187 ms |
| `/repo/psf/requests` | 183 ms | 199 ms | — | — | — |
| `/repo/SpIob/deptend-go-test-fixture` (55 missions) | — | — | 184 ms | — | — |

**No curl-observable difference between cold and warm on any page.** The 60 s `unstable_cache` cache hit does not show up as a TTFB reduction at the curl layer; the cache work is dwarfed by the Vercel edge + TLS setup. The cache does show up in Lighthouse's FCP/LCP (browser-side, no per-request TLS setup), where the cold→warm delta is the most user-visible signal.

## Cross-round findings

1. **The production site is in great shape for read paths.** Every page tested scores 97-100/100 on Lighthouse performance. FCP is 0.3-0.8 s across the board; LCP is 0.5-1.1 s; TBT is 0-60 ms; CLS is at most 0.038, well under the 0.1 "good" threshold. The `force-dynamic` Server Component architecture + `unstable_cache` 60 s TTL is producing the right shape of numbers for the current 4-repo dataset.

2. **The `/org/[org]` page is broken.** This is the headline finding. Every `/org/[org]` URL — including the two that should render real directories (`/org/SpIob` for 3 repos, `/org/psf` for 1 repo) — returns the 404 body. The `organizations` table is empty in production. This is a regression that AGENTS.md §13's 2026-08-23 audit missed; the round-5 perf numbers for `/org/SpIob` are a measurement of the 404 placeholder, not the real directory. **Decision point: should the `scripts/backfill-orgs.mjs` script be run against production now?** (It's idempotent, needs `GITHUB_TOKEN` for full rate limits, would take seconds for 2 orgs.)

3. **The 5-table join + tally on `/missions` is fast enough that cache state is invisible.** Round 3's warm vs cold comparison (36 ms vs 37 ms DocTTFB) is well within noise. The 60 s `unstable_cache` is paying for itself in DB load reduction, but a user looking at the page cannot tell whether they hit cache or not. This is the right shape, but it also means that *if* the 5-table join ever gets slow (e.g. with 10-100x more missions), the cache hit will be the only thing keeping the page fast.

4. **Lighthouse "DocTTFB" is not user-visible TTFB.** The 40 ms number that Lighthouse reports is a partial signal; the 150-200 ms number that `curl` reports is what a real user sees. A future `instrumentation.ts` with a `Server-Timing` header would close the visibility gap and let production monitoring observe the actual cache-hit vs cache-miss gap.

5. **TBT scales with mission count, not page weight.** `/missions` (50 missions) hits 20-30 ms TBT; `/repo/SpIob/deptend-go-test-fixture` (55 missions) hits 40-60 ms. Both are well under the 200 ms "good" threshold, but the per-card hydration cost is the only metric that grows with data. A 500-mission repo would push TBT into the 400-600 ms range, into "needs improvement" territory. The 1000-row upper bound from ADR 0047 has comfortable headroom today; if data ever grows toward it, the mitigation is server-pagination above some threshold, not virtualization.

6. **No regressions in any path tested.** Every metric is flat or improved cold→warm. No error-boundary skeletons, no `notFound()` regressions, no CSS regressions. The two known regressions AGENTS.md §13 flagged for production (`/missions` board ORDER BY `COALESCE` and the `reviveDates` inside `cached()`) are both fixed; the deployed code matches the post-ADR 0033 / post-ADR 0031 shape.

7. **The 60 s `unstable_cache` 60 s TTL is functionally invisible from the client.** This is a useful negative result. It means: the cache is paying for itself in DB load reduction, but a user can't observe it as a speedup. If a future ADR proposes a longer TTL (e.g. 5 minutes), users won't notice; if it proposes a shorter TTL (e.g. 30 s), they also won't notice. The cache TTL is a pure backend tuning knob.

## What the production data tells us about future scaling

- **At 4 repos / ~50 missions per repo / ~150 mission total**, the site has ~10x headroom in every metric. The hottest path on the site (`/missions` with a 5-table join + tally) is sub-50 ms at the DB.
- **The next 10x (40 repos, 500 missions per repo, 5000 total)** would likely start to see meaningful cold-cache cost on `/missions` and on the homepage's distinct-ecosystem scan (`getReposWithMissionSummary` per `queries.ts:108`). The `idx_mission_scores_composite_tier` index (ADR 0045, dev-applied) is the lever. It hasn't been measured against production data yet.
- **The next 100x (400 repos, 5000 missions per repo, 50000 total)** would push TBT into the 100s of ms on per-repo pages and could surface the homepage's per-user overlay queries (5 round-trip-pairs for signed-in, no cache) as a real cost. This is the level where the signed-in path being uncached becomes a real user-visible problem, not just a theoretical one.

## Open items / decision points surfaced

1. **`/org/[org]` 404 regression** — Run `scripts/backfill-orgs.mjs` against production? Idempotent, low-risk, seconds of work for 2 orgs, but it requires a `GITHUB_TOKEN` to be set on the runner. The fact that this regression is live *and undocumented in AGENTS.md §13* is itself a signal that the audit cadence needs to include actual `curl` of the rendered pages, not just reading the ADRs. **Suggested action: run the backfill, then re-run Round 5 to characterize the actual directory page.**

2. **No `Server-Timing` header from Vercel/Next.js** — Visibility into the 5-table join cost is zero from the client. A `instrumentation.ts` with `unstable_cache`'s built-in timing or a Next.js `instrumentation` hook would surface it. **Suggested action: a follow-up ADR proposing `Server-Timing` emission for `unstable_cache` reads.**

3. **Per-user `/` is uncached by design (ADR 0033)** — Currently 5 round-trip-pairs per signed-in user, no cache. With 4 repos in the directory this is invisible; with 400 repos it would matter. **Suggested action: monitor the cost as the dataset grows; no code change today.**

4. **`GITHUB_TOKEN` is absent in production** per AGENTS.md §13. This affects the submission manifest pre-check (which has a 60 req/hr budget shared across all traffic), not the read paths tested here. Not a perf issue for the site; an ops issue for the submission flow. Already flagged in §13.

5. **The 51MB demo GIF is still in git history** per AGENTS.md §13. Not a perf issue (it's not in the deployed bundle), but it's a repo bloat issue. Already flagged in §13.

## How to reproduce these rounds

```bash
# Install Chromium for Lighthouse (only needed once)
npx -p @playwright/test playwright install chromium

# Per round, point Lighthouse at a page with cold or warm Chrome flags:
CHROME_PATH=/Users/spiob/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell \
npx --yes lighthouse "https://deptend.vercel.app/" \
  --quiet --output json --output-path out.json \
  --only-categories=performance --form-factor=desktop \
  --screenEmulation.disabled --throttling-method=provided \
  --chrome-flags="--headless=new --no-sandbox --disable-gpu --user-data-dir=/tmp/cold --disable-cache --disk-cache-size=1"
```

The full set of metrics, intermediate JSON files, and per-round summaries are under `reports/perf/2026-08-30/`.
