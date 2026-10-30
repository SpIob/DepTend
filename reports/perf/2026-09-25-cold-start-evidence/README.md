# Cold-start evidence — 2026-09-25 audit pass (TASK-01)

Local Lighthouse runs against https://deptend.vercel.app/ taken during the
2026-09-25 audit pass, preserved as the evidence behind the CHANGELOG's
2026-09-25 TASK-01 entry ("Home page `/` performance regression diagnosed").

## Files

- `local-root.json` — cold-ish run (fresh Chrome profile, `--disable-cache`),
  perf score 76, LCP 2318.7ms
- `local-root-warm.json` — immediate re-run (same session, cache disabled),
  perf score 78, LCP 2268.3ms

## What they show

The LCP breakdown (`audits.metrics` → `timeToFirstByte` + `lcpRenderDelay`):

| Run               | TTFB      | lcpRenderDelay | LCP        | TBT | bootup |
| ----------------- | --------- | -------------- | ---------- | --- | ------ |
| `local-root`      | ~175 ms   | ~2144 ms       | 2318.7 ms  | 0   | 0      |
| `local-root-warm` | ~131 ms   | ~2137 ms       | 2268.3 ms  | 0   | 0      |

The DB render is fast (all 7 chunks arrive within ~180 ms of the headers;
TBT=0, bootup=0) and the regression is **Vercel Hobby function cold start +
first-visit-after-idle**, not the page render — the DB-free `/api/bogus`
route paid the same ~1.5 s cold during the same pass. No code change gamed
the thresholds.

## Why these were moved

Both files were originally committed at `reports/perf/local-root{,-warm}.json`
(f2cbd93) — at the top level of the directory the weekly audit's assert step
globs. That made every weekly run "fail" on these two stale slugs (phantom
FAILs for files that are not fresh prod measurements) on top of any real
finding; audit #11 (2026-09-27, run 36304685824) failed "3 pages" when only 1
was a fresh measurement. Fixed 2026-09-27: the assert glob narrowed to
`*.report.json` (what the CI Lighthouse run actually writes) and these files
moved here, out of the glob's reach. Evidence preserved, not deleted.

## Note on element identity

Both reports have `audits["largest-contentful-paint"].details` = null —
`--screenEmulation.disabled` (used by the weekly workflow and these local
runs) does not capture the LCP element node. The 2026-08-30 and 2026-09-05
baselines have the same gap; sub-part diagnosis comes from
`audits.metrics.details.items[0]` instead.
