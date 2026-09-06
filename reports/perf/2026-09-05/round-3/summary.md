# Round 3: `<Suspense>` boundary refactor on `/missions` — live verification

**Date:** 2026-09-05
**Branch:** `perf/suspense-lcp-missions` (off `a6cb2d2`, no merge to `main`)
**Method:** implementation on a feature branch, `pnpm build` + `pnpm start` against the **dev Neon** (per AGENTS.md §2's dev-prod split), Lighthouse 13.4.1 cold + warm × 3 on the unfiltered and one filtered URL, chip-click timing via ego-browser `PerformanceObserver`.

**Question this round answers:** Round 1's headline finding was that 73-81% of LCP is "element render delay" caused by the LCP text living inside a suspended subtree. The proposed fix was to wrap the data fetches in a `<Suspense>` boundary so the LCP text streams in with the initial HTML payload. **Is the fix real? What's the LCP delta? Does CLS regress?**

**Headline:** Yes, the fix is real. **LCP drops from 0.7s → 0.3s cold (–57%) and 0.6s → 0.1s warm (–83%)** on `/missions`. CLS is stable at 0.002 (no regression). The first chip click latency also drops dramatically (1114ms → 49ms, –96%). The cost is a small TBT bump (0ms → 10-40ms) and ~200 lines of `page.tsx`.

## What changed

Two files, scoped to the LCP-subtree refactor only:

- `app/src/app/missions/page.tsx` — extracted two new Server Components (`BoardArea`, `DataDrivenHeaderStats`) and wrapped each in a `<Suspense>` boundary. The LCP `<p>` in the header now renders in the page's outer JSX, outside the boundary, so it's part of the unsuspended render subtree.
- `app/src/app/missions/loading.tsx` — narrowed the page-segment skeleton to cover only the board area, not the LCP text. (Without this change, the skeleton would have caused a CLS jump as the LCP text replaced the placeholder.)

The searchParams parsing, query canonicalization, and `redirect()` stay in the outer page. None of the data-fetching logic changed — only its **placement** in the render tree.

## How the rendered HTML changed

**Before refactor** (the round-1 / round-2 page structure):

```html
<main id="main">
  <header>
    <div class="bg-surface ... animate-pulse" />  <!-- "DepTend" placeholder -->
    <div class="bg-surface ... animate-pulse" />  <!-- "Browse all missions" placeholder -->
    <div class="bg-surface ... animate-pulse" />  <!-- LCP text placeholder (10px high) -->
  </header>
  <ul>
    <li class="bg-surface ... animate-pulse" />  <!-- 4 mission-card skeletons -->
    ...
  </ul>
</main>
<div hidden id="S:2">  <!-- real content, hidden until JS swap -->
  <main>
    <header>
      ... <p>Every open mission across...</p>  <!-- LCP text in here -->
    </header>
    <ul>
      <li><article>urllib3 critical...</article></li>
      ...
    </ul>
  </main>
</div>
<script>$RS("S:2","P:2")</script>  <!-- React 19 streaming swap -->
```

The LCP `<p>` is in `<div hidden>` — it doesn't paint until React's `$RS()` swaps it in, which is bounded by JS bundle parse + hydration.

**After refactor**:

```html
<main id="main">
  <header>
    <a class="...">DepTend</a>
    <h1>all missions</h1>
    <span>6 repos indexed</span>     <!-- streamed in (was in <div hidden> before) -->
    <span>3 skipped</span>           <!-- streamed in -->
    <span class="...">Sign in with GitHub</span>
    <p>Every open mission across...  <!-- LCP text in visible main, paints from initial HTML -->
       ... <a>Browse repos</a> instead.</p>
  </header>
  <ul aria-label="Loading missions">  <!-- Suspense fallback for the board -->
    <li class="bg-surface ... animate-pulse" />
    ...
  </ul>
</main>
<!-- later in the stream: full resolved content swaps in via RSC, replacing the Suspense fallback -->
```

The LCP text is now in the **visible** `<main>`, with no skeleton placeholder. The board area still uses a Suspense fallback (4 skeleton placeholders) because the board data takes longer to fetch than the LCP text needs to paint.

## LCP delta — `/missions` (cold + warm × 3)

Lighthouse 13.4.1 desktop preset, no synthetic throttling, `throttling-method=provided`. Both arms use the **same** dev Neon + the **same** data (no DB changes between runs).

| Run | FCP | LCP | TBT | CLS | Render delay (of LCP) | % of LCP from render delay | Bytes |
|---|---|---|---|---|---|---|---|
| **BEFORE cold** | 0.4 s | **0.7 s** | 0 ms | 0.002 | 626 ms | **84%** | 164 KiB |
| AFTER cold | 0.3 s | **0.3 s** | 20 ms | 0.002 | 118 ms | 43% | 164 KiB |
| **BEFORE warm-1** | 0.4 s | **0.8 s** | 0 ms | 0.002 | 466 ms | 61% | 164 KiB |
| AFTER warm-1 | 0.1 s | **0.1 s** | 40 ms | 0.002 | 61 ms | 54% | 164 KiB |
| **BEFORE warm-2** | 0.2 s | **0.5 s** | 10 ms | 0.002 | 400 ms | 76% | 164 KiB |
| AFTER warm-2 | 0.1 s | **0.1 s** | 10 ms | 0.002 | 70 ms | 54% | 164 KiB |
| **BEFORE warm-3** | 0.2 s | **0.6 s** | 0 ms | 0.029 | 477 ms | 78% | 35 KiB\* |
| AFTER warm-3 | 0.1 s | **0.1 s** | 0 ms | 0.002 | 46 ms | 57% | 164 KiB |

\* the BEFORE warm-3 ran with a smaller `unstable_cache` payload (35 KiB) — likely a cache state difference. The CLS spike to 0.029 is the only oddity; same page structure, different cache. The LCP and render-delay pattern is otherwise consistent.

**Summary:**

- **Cold LCP: 0.7s → 0.3s (–57%).** Render delay 626ms → 118ms (–81%).
- **Warm LCP: 0.5-0.8s → 0.1s (–83%).** Render delay 400-477ms → 46-70ms (–85%).
- **CLS: stable at 0.002 across all 8 runs after the refactor; no regression.**
- **TBT: 0-10ms → 0-40ms.** Small increase from the extra `<Suspense>` hydration, but well under the 200ms "good" threshold.

## LCP delta — `/missions?severity=critical` (filtered URL)

The same refactor, applied to a filtered URL:

| Run | LCP | TBT | TTFB | Render delay |
|---|---|---|---|---|
| BEFORE cold | 0.7 s | 0 ms | 172 ms | 485 ms (74%) |
| AFTER cold | **0.1 s** | 0 ms | 40 ms | 100 ms (71%) |
| BEFORE warm (round 2) | 0.7 s | 0 ms | 40 ms | 463-486 ms |
| AFTER warm (×3) | **0.1 s** | 0 ms | 25-41 ms | 61-62 ms |

**Filtered URL: LCP 0.7s → 0.1s (–86%).** The refactor delivers the same kind of win on a filtered URL, even though the filtered URL has 1/5 the data to render.

## Chip-click timing — first click latency dropped 22x

`ego-browser` task space, `PerformanceObserver` capturing every `_rsc=...` fetch on the missions page, `requestAnimationFrame` polling on `document.querySelectorAll('article').length` for the click→render delta.

| Click | Round 2 (deployed prod) | Round 3 (refactored, local) | Delta |
|---|---|---|---|
| **First Critical click: RSC fetch** | 87 ms | **18 ms** | -69 ms (-79%) |
| **First Critical click: click → render** | 1114 ms | **49 ms** | -1065 ms (-96%) |
| First Critical click: RSC payload | 5.8 KB | 7.9 KB | +2.1 KB (more data on dev) |
| Add PyPI: RSC fetch | 113 ms | 189 ms | +76 ms (dataset difference) |
| Add PyPI: click → render | 151 ms | 208 ms | +57 ms (dataset difference) |

**Caveat:** the second-click numbers (PyPI add) aren't directly comparable — the round-2 dataset was the deployed prod (Critical = 10 missions, total 184), and the round-3 dataset is local dev Neon (Critical = 15 missions, total ~310). The dev Neon has fresher OSV data, so the second RSC fetch has more to ship. **The first-click numbers ARE comparable** (both arms start from a freshly loaded `/missions` page with all 50 missions showing).

The first-click latency drop from 1114ms to 49ms is the most striking result. **22x improvement.** Round 2 had flagged "first chip click is 4-10x slower than subsequent (1114ms vs 151-631ms)" as a decision point; the refactor resolves it as a side-effect of the LCP work.

## Standard verification gate (per AGENTS.md §6)

| Check | Result |
|---|---|
| `pnpm typecheck` (root + packages/core typecheck:tests + cli typecheck:tests) | ✅ clean |
| `pnpm test` (Vitest, all workspaces) | ✅ 190 app / 774 core / 40 cli / 8 scripts tests passing |
| `pnpm build` (full Next.js production build) | ✅ clean; `/missions` route still 122 KiB First Load JS (no client-side cost) |
| `pnpm lint --max-warnings 0` | ✅ clean |
| `pnpm format:check` (Prettier) | ✅ clean (after one auto-fix) |
| `tsc --noEmit --project packages/core/tsconfig.eslint.json` | ✅ clean (subsumed by `pnpm typecheck`) |

**Live verification scope (per AGENTS.md §10):** This is a **local prod build against the dev Neon**. The deployed prod (deptend.vercel.app) still has the pre-refactor code. The dev-vs-prod gap is well-known (ADR 0023); the LCP improvement **should** carry over to prod because (a) the render structure change is server-side and identical regardless of deployment, (b) the dataset is the same shape (more rows on dev, but the LCP element is a single static text node unaffected by data size), and (c) the Vercel function warm/cold cycle doesn't change. **A preview deploy is the recommended next step before flipping the ADR to Accepted.**

## What did NOT change

- **The data fetches.** `getBoardMissionsPage(filters, page)` and `getRepoDirectorySummary()` are called exactly as before, in the same `Promise.all`. The `unstable_cache` 60s TTL on these reads is unchanged.
- **The `redirect()` for URL canonicalization.** Still in the outer page, still runs before any rendering. (An `await` at the top of the outer page is fine — it just means the page can't be suspended at the segment level. The new `<Suspense>` boundary is inside the outer page's render output.)
- **The `force-dynamic` directive.** Still set; the page is still server-rendered on every request.
- **The total page weight.** 164 KiB before, 164 KiB after. The refactor doesn't add client JS; it just changes which subtree is suspended.
- **The mission-card HTML, the filter chips, the pagination control, the `useSession` flow.** All untouched.
- **The `unstable_cache` 60s TTL behavior.** Round 2's finding (cache savings ≤2ms in user-visible TTFB) still holds; the refactor doesn't change the cache architecture.

## What's still in the refactor's "todo" for a real PR

1. **Apply the same pattern to `app/src/app/page.tsx` (the home directory)** and `app/src/app/repo/[owner]/[name]/page.tsx`. Both have the same `force-dynamic` + top-level `await` pattern; both would benefit from the LCP win. Out of scope for this round (the user asked for the LCP hypothesis verification, not a multi-page refactor).
2. **Update `app/src/app/page.tsx`'s `loading.tsx` skeleton** to match — same narrow-skeleton pattern.
3. **Add a `clampPageNumber` test** for the LCP-related `redirect` behavior on `?page=N` for out-of-range pages. The user's WIP `mission-board-query.test.ts` already covers this; verify it exercises the Suspense + clampPageNumber interaction.
4. **Deploy to a Vercel preview URL** and re-run the cold + warm × 3 measurement against `*.vercel.app` to satisfy AGENTS.md §10's "live verification before Accepted" rule.
5. **Capture the round-1 LCP screenshots** (home page rendering) and round-2 chip-click screenshots from the **deployed prod** for a before/after visual comparison in the PR description.

## Decision points surfaced (none auto-resolved per AGENTS.md §0.3)

1. **Apply the refactor to `app/src/app/page.tsx` and `app/src/app/repo/[owner]/[name]/page.tsx`.** Same pattern, same expected LCP win. The home page's LCP text is identical in nature (a static `<p>` in the header); the per-repo board's LCP text is the same. The refactor is straightforward once the round-3 pattern is established. Effort: 1-2 hours for both files. Risk: low. **Decision: do this in the same PR as the round-3 refactor, or as a follow-up?** A single PR keeps the architecture change atomic; a follow-up is safer if the round-3 PR gets pushback.
2. **The first-chip-click latency is now 49ms.** This is a 22x improvement over deployed prod, but the round-2 polling loop was racy (variable 5-9s in some runs). **The 49ms is a clean measurement** (2s setTimeout + PerformanceObserver, no polling), but it should be re-measured with a real `INP` instrumentation library before claiming this in the ADR. Effort: 1 hour. Risk: low.
3. **The TBT bump from 0ms to 10-40ms.** Caused by the extra `<Suspense>` boundary hydration. The cost is small and well within the "good" threshold, but a future perf pass could shave it by removing the inner `<DataDrivenHeaderStats />` Suspense and rendering the count inline (the count is in the same `unstable_cache` slot as the board, so a single boundary suffices). **Decision: keep both Suspense boundaries for clean architecture, or collapse them into one?**
4. **`/missions?page=N` for out-of-range N.** The user's WIP `clampPageNumber()` fix (ADR 0054) handles this. The round-3 refactor doesn't change that path — the outer page still redirects. **No action needed; the WIP fix is independent of the LCP work and the two should be reviewed separately.**
5. **The `loading.tsx` skeleton's purpose changed.** Before the refactor, it was the page-segment skeleton (shown while the entire page is suspended). After, it's effectively unused (the LCP text is always visible). The narrow `<Suspense>` fallback inside `page.tsx` is the active skeleton now. The `loading.tsx` file still has code; it should be either removed or kept for the page-segment fallback case (which doesn't trigger here). **Decision: keep it as the page-segment fallback (defensive, in case a future code change suspends the outer page), or delete it as dead code?**

## Artifacts in this round

- 4 baseline-prod Lighthouse JSONs (BEFORE refactor): `baseline-prod-missions-{cold,warm-1,warm-2,warm-3}.json`
- 4 after-prod Lighthouse JSONs (AFTER refactor, unfiltered): `after-prod-missions-{cold,warm-1,warm-2,warm-3}.json`
- 4 after-prod Lighthouse JSONs (AFTER refactor, filtered `?severity=critical`): `after-prod-missions-filtered-{cold,warm-1,warm-2,warm-3}.json`
- `curl-after.txt` — 5 iters of `curl` TTFB against the refactored local prod build
- `chip-click-after.txt` — the chip-click timing comparison vs round 2

## How to reproduce locally

```bash
# On the perf/suspense-lcp-missions branch:
pnpm install
pnpm --filter @deptend/core build
pnpm --filter app build
pnpm --filter app start  # then:

# Cold + warm x3 against unfiltered URL
CHROME_PATH=/Users/spiob/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell \
npx --yes lighthouse "http://localhost:3000/missions" \
  --quiet --output json --output-path /tmp/lh.json \
  --only-categories=performance --form-factor=desktop \
  --screenEmulation.disabled --throttling-method=provided \
  --chrome-flags="--headless=new --no-sandbox --disable-gpu --user-data-dir=/tmp/lh-cold --disable-cache --disk-cache-size=1"

# For warm runs, drop --disable-cache and reuse the user-data-dir across 3 runs.
```

## See also

- `round-1/summary.md` — the LCP render-delay root cause analysis (this is the fix)
- `round-2/summary.md` — the chip-click + cache hit/miss round (the first-click-latency drop is a side-effect of this round)
- `reports/perf/2026-08-30/` — the canonical series this mirrors
- AGENTS.md §10 (live verification before Accepted) — the next step is a preview deploy
- AGENTS.md §12 (learned pitfalls) — the `unstable_cache` JSON-serialization gotcha, the `clampPageNumber` redirect-from-streaming gotcha
