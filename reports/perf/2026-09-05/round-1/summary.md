# Round 1: Cold + warm × 3 baseline — anonymous

**Date:** 2026-09-05
**Method:** Lighthouse 13.4.1 (desktop preset, no synthetic throttling, `throttling-method=provided`), Chromium headless via Playwright (`/Users/spiob/Library/Caches/ms-playwright/chromium_headless_shell-1234`), `curl`, ego-browser for visual checks + DOM analysis.

**Tooling notes for this round:**

- ego-browser task space: `deptend perf series 2026-09-05` (id=2)
- One cold run per URL with a fresh `user-data-dir` (`--disable-cache --disk-cache-size=1`); 3 warm runs back-to-back per URL with persistent `user-data-dir`.
- 5 `curl` probes per URL for the real user-visible TTFB (Lighthouse's `server-response-time` audit excludes connection setup; `curl` includes it).
- All four pages confirmed to render real content via screenshot + DOM dump; no error-boundary skeletons, no 404 bodies, no JS console errors. (Last regression: `/org/[org]` 404 from 2026-08-30; resolved by 2026-08-30 round-5-fixed backfill; not regressed.)

## Per-URL Lighthouse matrix

All values from Lighthouse 13.4.1 desktop preset, `throttling-method=provided`. DocTTFB is Lighthouse's "Root document took N ms" audit (excludes connect+TLS); curl TTFB below is the user-visible end-to-end including Vercel edge + TLS.

### Round 1 — cold (1 run, fresh profile)

| Page | FCP | LCP | TBT | CLS | DocTTFB (LH) | Perf | Page bytes |
|---|---|---|---|---|---|---|---|
| `/` | 0.6 s | 1.0 s | 0 ms | 0.033 | 40 ms | 99/100 | 139 KiB |
| `/missions` | 0.4 s | 0.7 s | 0 ms | 0 | 50 ms | 100/100 | 156 KiB |
| `/org/SpIob` | 0.5 s | 0.8 s | 0 ms | 0.008 | 50 ms | 100/100 | 140 KiB |
| `/repo/SpIob/deptend-go-test-fixture` | 0.4 s | 0.8 s | 0 ms | 0 | 40 ms | 100/100 | 166 KiB |

### Round 1 — warm (median of 3)

| Page | FCP | LCP | TBT | CLS | DocTTFB (LH) | Perf | Page bytes |
|---|---|---|---|---|---|---|---|
| `/` | 0.4 s | 0.6 s | 0 ms | 0.030 | 40 ms | 100/100 | 138 KiB |
| `/missions` | 0.4 s | 0.7 s | 0 ms | 0 | 40 ms | 100/100 | 156 KiB |
| `/org/SpIob` | 0.3 s | 0.5 s | 0 ms | 0.008 | 50 ms | 100/100 | 142 KiB |
| `/repo/SpIob/deptend-go-test-fixture` | 0.4 s | 0.7 s | 0 ms | 0 | 40 ms | 100/100 | 166 KiB |

### curl TTFB (median of 5 per URL)

| Page | Median TTFB | p95 | Median bytes |
|---|---|---|---|
| `/` | 186 ms | 214 ms | 34 059 |
| `/missions` | 182 ms | 319 ms | 469 277 |
| `/org/SpIob` | 207 ms | 292 ms | 29 456 |
| `/repo/SpIob/deptend-go-test-fixture` | 190 ms | 261 ms | 589 224 |

`/missions` and `/repo/.../deptend-go-test-fixture` carry the full 50-mission / 55-mission board payload server-side; 470 KiB and 590 KiB respectively. Both still <200 ms median TTFB.

## LCP element analysis — every page has the same pattern

Lighthouse's `lcp-breakdown-insight` shows where the LCP time is spent. The split is `timeToFirstByte` (the actual server work + first byte over the wire) vs `elementRenderDelay` (everything from TTFB to LCP paint):

| Page | LCP (ms) | TTFB (ms) | Element render delay (ms) | % of LCP from render delay | LCP element |
|---|---|---|---|---|---|
| `/` | 965 | 181 | **783** | **81%** | `body > main > header > p.text-ink-muted` (the page subtitle "Every indexed repo, with its highest-priority missions summarized…") |
| `/missions` | 710 | 192 | **518** | **73%** | `body > main > header > p.text-ink-muted` ("Every open mission across every indexed repo…") |
| `/org/SpIob` | 772 | 190 | **582** | **75%** | a per-repo `p.text-ink-muted` line-clamp-2 description inside `RepoCard` |
| `/repo/SpIob/deptend-go-test-fixture` | 792 | 187 | **605** | **76%** | `body > main > header > p.text-ink-muted` |

**The LCP text on three of the four pages is identical in nature: the muted paragraph at the top of the page header.** On `/org/[org]` it's the per-repo `p.text-ink-muted` inside the first `RepoCard` (line-clamp-2).

`elementRenderDelay` here is genuinely large: 518-783 ms, dominating LCP on every page. TTFB (the actual server response) is fine. Whatever happens **after** the first byte lands is where the time goes.

## Root cause: the page is `force-dynamic` with no `<Suspense>` boundary around the LCP text

This is the headline finding of this round.

### How the SSR HTML is shaped

`curl -s https://deptend.vercel.app/` shows the page is delivered as **two parallel structures**:

```html
<!-- The visible <main> with skeleton placeholders -->
<main id="main">
  <header>
    <div class="bg-surface h-6 w-40 animate-pulse"></div>   <!-- "DepTend" placeholder -->
    <div class="bg-surface h-10 w-full max-w-xl animate-pulse"></div>  <!-- the LCP text slot -->
  </header>
  <ul>
    <li class="border-border bg-surface h-36 animate-pulse rounded-md border"></li>
    <li ...></li>                                            <!-- 4 skeleton repo cards -->
  </ul>
</main>

<!-- The real content, hidden, swapped in by a script after hydration -->
<div hidden id="S:2">
  <main>
    <header>
      <span>DepTend</span>
      <p class="text-ink-muted">Every indexed repo, with its highest-priority missions…</p>
    </header>
    <ul>
      <li><article>SpIob/deptend-go-test-fixture …</article></li>
      <li><article>SpIob/FlowState …</article></li>
      <li><article>psf/requests …</article></li>
      <li><article>SpIob/Bagong-Enerhiya …</article></li>
    </ul>
    <section>1 skipped …</section>
  </main>
</div>

<script>$RS("S:2","P:2")</script>   <!-- React 19 streaming swap -->
```

The `<p>Every indexed repo…</p>` is in `<div hidden>`, not in the visible `<main>`, until React's `$RS` (Reactive State) helper moves the real content in. The swap only happens after the JS bundles load, parse, and run.

### Why this happens (Next.js App Router semantics)

`app/src/app/page.tsx:16` is `export const dynamic = "force-dynamic"`. The page is an async Server Component that does:

```ts
const session = await getServerSession(authOptions);
const login = session?.user?.login;
const [repos, { totalCount, skippedRepos }] = await Promise.all([
  getReposWithMissionSummary(login),     // DB read
  getRepoDirectorySummary(),              // DB read
]);
```

Both reads are awaited at the top of the page, **before** any JSX is returned. Because there's no `<Suspense>` boundary around the data fetch and the LCP text is in the same render unit, Next.js's streaming has no opportunity to flush the LCP text early. The LCP text is delivered as part of the **suspended** subtree; the skeleton (`app/src/app/loading.tsx`) is the immediate placeholder for the page segment.

The same pattern applies to `/missions/page.tsx:51` (also `force-dynamic`, top-level `await searchParams` + `await getBoardMissionsPage`) and `/repo/[owner]/[name]/page.tsx`. The `missions/loading.tsx` and root `loading.tsx` are the fallbacks.

The chain: the LCP element lives inside a render subtree that is gated on awaited Server Component work. The HTML response streams the skeleton first, then the real content (Lighthouse's TTFB includes both). Chrome's LCP algorithm picks the `<p>` in the hidden `<div>` as the LCP element once it becomes visible — and visibility happens after `$RS()` runs, which is bounded by:
- JS bundle parse + execution
- React hydration of the page segment
- The DOM swap

That's the 500-800 ms "element render delay."

### Why this is design-correct but not optimal

- **It's not a bug.** The skeleton-to-content swap is the deliberate Next.js App Router streaming + `force-dynamic` pattern; `loading.tsx` is intentional. No error boundaries are firing; nothing is broken. `force-dynamic` is required by AGENTS.md §2 (mission/repo state changes on every request, so build-time snapshots would be stale).
- **It is improvable.** The LCP text doesn't depend on the data fetches. `getServerSession` and the DB reads feed `<AuthStatus>`, `<SubmitRepoForm>`, and the `RepoCard` grid — none of which the LCP paragraph depends on. A `<Suspense>` boundary around the data fetches would let the LCP text stream in independently, before the DB roundtrip finishes, and the skeleton would only fill the parts that actually wait on the data.
- **The 3 warm runs do not show a smaller render delay.** Even warm, the LCP element render delay is still ~500 ms. Caching helps DB work, not the JS-bundle-load-and-swap path.

## Other findings (smaller, none critical)

### Server-Timing middleware phase (ADR 0052)

Confirmed live on every non-asset response: `Server-Timing: total;dur=0.3` (median across all 16 runs). Per ADR 0052, this is the **middleware phase only** — nonce generation, CSP build, `NextResponse.next()` setup. It does not include the page render or DB queries. Per-segment timing is the flagged follow-up. The 0.3 ms is honest: middleware is cheap; the cost is downstream of it.

### Auth session calls (negative result)

Initial methodology suggested repeated `/api/auth/session` polling on every page (e.g., 24 calls in 15s on `/`). After correcting the test by calling `performance.clearResourceTimings()` on `pageshow` and re-running with the buffer cleared, **0 session calls in 30s** on every page after the initial one. The earlier numbers were a `PerformanceObserver` buffer-staleness artifact from repeated `openOrReuseTab` navigations on the same task space. Negative result: session polling is fine; one call per page load is what the code does.

### RSC prefetches on the home page

The home page fires **5 RSC prefetches** in parallel on load (one for `/missions`, one per repo card). Each returns ~1.4 KiB (the empty RSC shell — the heavy 470 KiB missions page is **not** prefetched in full). Total: 7 KiB, 92-113 ms each. This is the correct Next.js `Link` behavior and not a perf issue; the prefetches make client-side navigation feel instant.

### Bundle / render-blocking

Lighthouse reports **0 render-blocking resources** on every page, TBT is 0 ms on every page, total page weight is 138-166 KiB. The build is in good shape; there's no low-hanging fruit from "stop blocking render" or "split the bundle" type optimizations.

## Open decision points surfaced

1. **LCP element render delay (518-783 ms)** — A `<Suspense>` boundary around the data fetches on each `force-dynamic` page would let the LCP text stream in earlier, reducing LCP by roughly 400-600 ms (the 0.6-1.0 s LCP would drop to ~300-500 ms). The refactor touches 3 page files: `app/src/app/page.tsx`, `app/src/app/missions/page.tsx`, `app/src/app/repo/[owner]/[name]/page.tsx`. ADR-worthy. **Risk:** needs to preserve the "live data" model (no `unstable_cache` regression on the LCP subtree). The LCP text is currently static per page; streaming it doesn't need caching, only a `<Suspense>` boundary. Decision: scope of the refactor (just LCP text, vs full server-component restructure); whether to also add `loading.tsx` skeletons at the data-fetch boundary instead of at the page-segment boundary.
2. **Per-segment Server-Timing (ADR 0052 follow-up)** — The current `total;dur=0.3` is honest but uninformative. A `Next.js instrumentation.ts` hook or a custom `unstable_cache` wrapper that records `cache;dur=…, db;dur=…, render;dur=…` per request would expose the 5-table join cost, the `unstable_cache` hit/miss gap, and the render phase separately. App-Router middleware cannot read segments set during page render (called out in AGENTS.md §12). Implementation: a `withTiming(label, fn)` helper used in `app/src/lib/queries/missions.ts` and the page components, with results piped through a `headers().set('Server-Timing', ...)` call from the page. Decision: scope (just DB or all phases), and where the timing helper lives.
3. **`/missions` payload size** — 470 KiB of HTML for a 50-mission page. The HTML is gzipped in transit (Lighthouse reports 165 KiB transferred) and TBT is 0 ms, so this is not user-visible today. The ADR 0047 `LIMIT 1000` upper bound on per-repo boards is the right guard; on `/missions` (cross-repo), the limit is the existing 50 per page. If `/missions` ever lands in the Lighthouse "Avoid enormous network payloads" warning, the lever is to reduce per-card HTML density or to switch to a client component that fetches the mission detail on demand.
4. **A test methodology note worth surfacing to AGENTS.md** — `PerformanceObserver` with `buffered: true` re-reports entries from prior navigations in the same task space; without an explicit `performance.clearResourceTimings()` on `pageshow`, multi-page ego-browser rounds will report session/RSC/etc. calls that didn't actually happen on the current page. The current round-1 numbers from 2026-08-30 (`FCP 0.4-0.8 s`) are not affected (they were Lighthouse-driven, not ego-browser), but a future series that uses `PerformanceObserver` across multiple `openOrReuseTab` calls needs to clear the buffer between navigations. **Decision: add a one-line note to AGENTS.md §9 / §6 explaining the gotcha, similar to the `reviveDates` placement issue already called out in §12.**

## Cross-round comparison

vs. `reports/perf/2026-08-30/round-1/` and `2026-08-30/round-2/` (5 days ago, same data state broadly):

- **FCP cold 0.4-0.8 s → 0.4-0.6 s.** Slight improvement; sample noise.
- **LCP cold 0.8-1.1 s → 0.7-1.0 s.** Slight improvement.
- **TBT 10-60 ms → 0 ms across the board.** This is the most interesting delta. Either the 2026-08-30 dataset had more missions, or some code change since then reduced main-thread blocking during hydration. The 0 ms result is consistent across all 4 pages × 4 runs (cold + 3 warm) = 16 measurements.
- **CLS unchanged** (still 0-0.033, all under the 0.1 good threshold).
- **Perf score unchanged** (97-100, all under 100 only on the `/` warm-3 and `/repo` warm-3 outliers, which the 2026-08-30 series also saw).
- **Page weights unchanged** (138-166 KiB). The `/missions` 470 KiB and `/repo/.../deptend-go-test-fixture` 590 KiB HTML bodies (compressed to ~165 KiB in transit) match 2026-08-30's numbers.

The TBT delta is the only noteworthy change. The score divergence from 2026-09-04 (`urllib3 GHSA-www2-v7xj-xrc6` showing 9.0 on dev vs 9.6 on prod) is data-state, not perf — see `2026-09-04-prod-vs-dev/score-divergence-root-cause.md` for the explanation; the numbers today on prod are still 9.6 for that mission.

## Artifacts in this round

- 4 cold JSONs: `home-cold.json`, `missions-cold.json`, `org-cold.json`, `repo-cold.json`
- 12 warm JSONs: `home-warm-{1,2,3}.json`, `missions-warm-{1,2,3}.json`, `org_SpIob-warm-{1,2,3}.json`, `repo_SpIob_deptend-go-test-fixture-warm-{1,2,3}.json`
- 4 screenshots: `home.png`, `missions.png`, `org.png`, `repo.png`
- 1 curl probes file: `curl-probes.txt`

## How to reproduce

```bash
# Install Chromium for Lighthouse (only needed once)
npx -p @playwright/test playwright install chromium

# Cold run, fresh profile
CHROME_PATH=/Users/spiob/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell \
npx --yes lighthouse "https://deptend.vercel.app/" \
  --quiet --output json --output-path out.json \
  --only-categories=performance --form-factor=desktop \
  --screenEmulation.disabled --throttling-method=provided \
  --chrome-flags="--headless=new --no-sandbox --disable-gpu --user-data-dir=/tmp/cold --disable-cache --disk-cache-size=1"

# Warm run, persistent profile (caches build up across the 3 runs)
CHROME_PATH=... npx --yes lighthouse "https://deptend.vercel.app/" \
  ... --chrome-flags="--headless=new --no-sandbox --disable-gpu --user-data-dir=/tmp/warm"

# curl TTFB
for i in 1 2 3 4 5; do
  curl -o /dev/null -s -w "%{time_starttransfer} " "https://deptend.vercel.app/"
done
```

## What's coming in round 2 (planned)

- **`/missions` filter change behaviour**: click each impact/ecosystem/effort/type chip, measure cache-hit vs cache-miss TTFB. This is the realistic user workflow; the existing 2026-08-30 round-3 didn't cover chip clicks.
- **`/repo/.../deptend-go-test-fixture` warm LCP under realistic load**: this page renders 55 missions and the LCP is 0.7-0.9 s. Worth a closer look at whether `<Suspense>` around the mission list (independent of the header) would move LCP down to ~400 ms.
- **Mission `confidence: low` showing on every Go card in `/repo/.../deptend-go-test-fixture`** — the screenshot shows every Go mission has the "low confidence" pill. Per AGENTS.md §11, `no_lock_file` is the only flag that should be set on a fully-ingested Go repo (the others all have Go data), which would put these cards at `"medium"`. Worth confirming the Go lock-file parser (`go.sum` per ADR 0038) is actually being invoked end-to-end and the flag is correctly cleared.
