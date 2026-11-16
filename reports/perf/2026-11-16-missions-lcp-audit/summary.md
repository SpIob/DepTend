# 2026-11-16 — /missions LCP regression investigation

**Trigger:** kanban task "Fix LCP regression on /missions page". The premise came from the weekly
Lighthouse trend: `/missions` LCP 317 ms (11-01 run) → 463 ms (11-08) → 465 ms (11-15), making it
the worst of the four audited pages after having been the best.

**Outcome:** no app-code LCP regression exists. The weekly drift is single-run measurement noise
(iad runner ↔ sin1 function flight variance) that the median-of-3 assert added in the same pass
now absorbs. The only >1 s LCP path is the Vercel Hobby function cold start — a documented
infrastructure property (CHANGELOG 2026-09-25 TASK-01, reports/perf/2026-09-25-cold-start-evidence/),
not page code. Evidence for both claims below.

## 1. The weekly series is noise, not a trend

Weekly audit Lighthouse LCP for `/missions` (desktop, `--throttling-method=provided`, single run,
GitHub-hosted runner):

| Run date | LCP (ms) | TTFB (ms) | doc stream end (ms) | lcpRenderDelay (ms) | doc payload (B) |
| --- | --- | --- | --- | --- | --- |
| 10-04 | 522 | 70 | 520 | 452 | — |
| 10-18 | 396 | 14 | 665 | 382 | 439,010 |
| 10-25 | 396 | 16 | 764 | 381 | — |
| 11-01 | 317 | 2 | — | — | — |
| 11-08 | 463 | 32 | 803 | 431 | 433,270 |
| 11-15 | 465 | 27 | 833 | 439 | 433,271 |

Raw: `weekly-lcp-series.json` (from artifacts of runs 37188406392, 39106581987, 40172986607,
42464629067, 43697652875).

- The series is **not monotonic**: 10-04 measured 522 ms — higher than the "regressed" 463-465.
- Every client-side metric *improved* over the same window (TBT 121→0 ms, bootup 251→55 ms,
  mainthread 478→208 ms — the 10-30 minor-and-patch dependency bump #20's react 19.3.1 effect),
  while FCP moved 1:1 with LCP (+69 ms) and every resource's request start shifted by the same
  ~+80 ms (first script 338→417 ms). A uniform whole-page shift is delivery variance, not render cost.
- `lcpRenderDelay` (LCP − TTFB) = 381-452 ms across all runs — that is the shell's flight time
  from the sin1 function to the iad runner, which no app change can reduce. The doc payload
  *shrank* 439,010 → 433,271 B while doc stream end *grew* 665 → 833 ms — delivery, not size.

## 2. Live measurement: LCP element paints from the initial flush (round-3 architecture intact)

ego-browser (Chromium, Singapore vantage — same region as the function), prod
`deptend.vercel.app/missions`, `Page.addScriptToEvaluateOnNewDocument` instrumentation with
buffered LCP PerformanceObserver + element attribution, cache-disabled and warm passes
(2026-11-16, probes in this directory's JSON files):

| Pass | TTFB | doc stream end | board swap | FCP | LCP | LCP element |
| --- | --- | --- | --- | --- | --- | --- |
| warm | 36-45 ms | 269-296 ms | +50-100 ms | 256-344 ms | = FCP | `p.max-w-xl` (header text, 21,804 px²) |
| cold function (pass A) | 36 ms (edge) | 1,042 ms | 1,242 ms | **1,268 ms** | = FCP | same `<p>` |

- **FCP == LCP in every pass, and the LCP element is always the static header `<p>`** ("Every open
  mission across every indexed repo…") — exactly what the 2026-09-05 round-3 Suspense refactor
  was built to guarantee. Element render delay: zero.
- Byte map of the streamed document (433,271 B raw): stylesheet at byte 135, the LCP `<p>` at byte
  **3,332**, the board skeleton at 3,641, the streamed board HTML at ~192,824. The LCP element
  sits ~3 KB into the first flush — the earliest position physically reachable. Nothing app-side
  can paint it earlier than the function's first body chunk.

## 3. The only real >1 s LCP path: Hobby function suspend

- curl against prod (sin1 vantage): first hit after idle TTFB **2.10 s**, warm repeats 0.23-0.46 s.
  Browser cold pass: FCP/LCP **1,268 ms** vs warm 256-344 ms — a ~4-5× real-user LCP penalty that
  applies to **every** page, not just `/missions`.
- Cold `lcpRenderDelay` is not render delay — the first *body byte* itself arrives ~1 s after the
  edge's optimistic response headers because the suspended isolate is booting. The `<p>` cannot
  paint before it exists.
- Root cause documented since 2026-09-25 (TASK-01): Hobby suspends functions after ~5 min idle at
  this site's traffic, so most real first visits pay it. `perf.yml`'s Warm step removes it from
  the weekly measurement only.
- Keeping the function warm for real users would need an external ~5-min pinger (GitHub Actions
  cron is too unreliable at 5-min granularity and the keep-alive must be DB-free to avoid burning
  Neon's free compute hours — 190 h/month cannot cover 24/7). Not built: it is an infrastructure
  trade-off decision, see "Decision point" below.

## 4. Code window check

`git diff 325eb3d..35f918d..HEAD -- app/src` (the 10-18 → 11-15 measurement window): the only
touch to `/missions`' render path is `app/src/app/missions/page.tsx` +9/-8 — the ADR 0052
follow-up's `logRequestTimings()` wiring, dev-only. No render-tree, query, or payload change.
(react 19.2.7→19.3.1 / next 15.5.24→15.5.28 in #20 changed hydration cost — in the improving
direction.)

## 5. What was changed (this pass)

- `.github/workflows/perf.yml`: the audit now runs **3 cold passes per page** (fresh
  `--user-data-dir` each) and asserts on the per-page **median** LCP and performance score instead
  of a single run. Thresholds unchanged (2500 ms / 80). A single-flight spike like the ones that
  produced the 317→522 ms series can no longer read as a regression; a genuine regression
  reproduces in all passes and still fails. Rationale: the 2026-09-27 cold-start-lottery trap
  (single-run assert misreading noise as a page regression) has a second face — same single run,
  favorable flight, misreading noise as a trend. Median-of-3 closes both.
- This report + raw probe evidence.

## Decision point (not auto-resolved, per AGENTS.md §0.3)

Real-user LCP on all pages is dominated by the Hobby cold start (~1-2.5 s on most first visits).
Options, none implemented:

1. **Accept** (status quo): the `<p>` paints immediately once the function is awake; warm LCP is
   150-350 ms. Zero cost, zero added moving parts.
2. **DB-free keep-alive** (external 5-min pinger hitting a database-free route, e.g. the
   `/api/*` JSON 404 envelope): removes the function-boot term from real-user LCP. Cost: ~9-11k
   invocations/month (inside Hobby's free 1M), a third-party uptime service dependency, and it
   does nothing for Neon suspension (irrelevant to LCP — the board fetches are behind Suspense).
3. **Speed up the cold boot itself**: not tractable app-side; the boot is Vercel's isolate spin-up.

Recommendation if the goal is "sub-second LCP for real first visits": option 2, implemented as an
uptime monitor against a DB-free path only.
