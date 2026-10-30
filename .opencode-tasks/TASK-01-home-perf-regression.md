# TASK-01 — Diagnose and fix the home page `/` performance regression

**Agent:** opencode · **Priority:** highest (weekly perf audit is failing on it)
**Area:** `app/src/app/page.tsx`, `app/src/components/repo-card.tsx`, `app/src/lib/queries/*`
**Blocks:** the Weekly performance audit workflow (`.github/workflows/perf.yml`), which
failed run 36080642160 (2026-09-25) and run 35497483978 (2026-09-20).

## Evidence (measured, live production)

Per-page Lighthouse results from run 36080642160 (desktop, cold-cache, first byte via
`--throttling-method=provided`):

```
missions.report:                   LCP= 430.774ms  score=87
org_SpIob.report:                  LCP= 423.694ms  score=100
repo_SpIob_deptend-go-test-fixture.report: LCP= 823.729ms  score=99
root.report:                       LCP=3224.595ms  score=59   ← FAIL (thresholds: 2500ms / 80)
```

Run-over-run trend: `/` LCP 2337→3224 ms, score 76→59 (2026-09-20 → 2026-09-25). Every
other page passes. TTFB on `/` measured at ~0.53 s warm (`server-timing: total;dur=0.5`),
so the LCP is NOT server response time — the suspect is what happens between first byte
and largest paint: streamed RSC content (the full repo directory + per-repo mission
summaries) arriving late against a **cold Neon compute**, and/or client-side hydration.
Note the run order: Lighthouse visits `/` FIRST (coldest DB of the run), then the other
pages (warm DB) — which matches exactly why only `/` fails. Neon project
`small-fog-28210807` has `suspend_timeout_seconds: 0` (suspends immediately when idle).

## Known constraints (from AGENTS.md — binding)

- The page stays `force-dynamic`; fix at the query/render layer, not by baking a
  snapshot at build time (page.tsx:12-16's own comment explains why).
- Read caching goes through `app/src/lib/queries/cached-read.ts` (ADR 0033): 60 s TTL,
  tags `missions`/`repos`; `reviveDates()` must stay applied to `cached()`'s RESULT,
  never inside the wrapped callback — that exact misplacement took `/` down in
  production once already (ADR 0033 correction note).
- **Do not game the thresholds.** The fix must make `/` pass the real 2500 ms / 80
  thresholds. Do not edit `perf.yml`'s thresholds as part of this task.
- Zero budget: any new dependency needs a documented reason (ADR or PR description).
- Per AGENTS.md §0.6, load `.opencode/skills/actually-code` before writing code.

## What to do

1. **Reproduce locally first.** Run Lighthouse against the live page once to capture the
   LCP element identity (the artifacts from run 36080642160 were not uploaded because
   the assert step failed first):
   `npx --yes lighthouse https://deptend.vercel.app/ --quiet --output json --output-path reports/perf/local-root.json --only-categories=performance --form-factor=desktop --screenEmulation.disabled --throttling-method=provided --chrome-flags="--headless=new --no-sandbox --disable-gpu"` —
   then read `reports/perf/local-root.json`'s `audits.largest-contentful-paint.details.items[0].node.selector`
   to identify the actual LCP element. Report what it is before changing anything.
2. **Check the DB-query share of the latency.** The `Server-Timing` header (ADR 0052)
   already carries per-segment timing (`cache:missions:board`, `cache:repos:*`,
   `cache:*:hit/miss/db`) — read it (`curl -sI https://deptend.vercel.app/`) and compare
   the middleware `total;dur` against the per-segment sums on a cold request. If the DB
   segments dominate, the fix is query-side; if render/hydration dominates, it's
   component-side.
3. **Fix the root cause**, per what steps 1–2 actually show. Likely candidates, in
   order of prior probability:
   - **Cold-Neon first-paint:** the first request after Neon suspends pays compute
     wake-up (~1–2 s) on top of the queries. If that's the dominant share, the fix is
     NOT in the app (it's a Neon idle-suspend behavior); document the finding in
     TASK-05's notes instead of "fixing" the app, and instead reduce what the page
     _renders_ (see next candidate).
   - **Unbounded render:** `page.tsx:107` maps ALL repos into the grid. If the repo
     count grows toward the 150 cap, this grows linearly. If the LCP element is inside
     a `RepoCard`, consider rendering only the first N (e.g. 12) repos server-side with
     a "show all" client-side expand — but ONLY if the evidence shows render cost is
     the problem, and keep the default view's information identical for the first N.
   - **Hydration-blocking client code:** if Lighthouse shows a long `bootupTime`
     (script eval), find which client component blocks (the `withTiming` store's
     dynamic `import()` inside `cached-read.ts`'s hot path is a suspect for
     server-render cost only — do not touch it without evidence).
4. **Verify against the real page** (AGENTS.md §6 meta-lesson): after the fix, re-run
   Lighthouse (warm AND cold — at minimum two runs) and attach both JSONs. `/` must
   pass 2500 ms / 80 on both. Then run the full §6 gate.
5. **Do not** add a new dependency for this. **Do not** edit thresholds. **Do not**
   touch `cached-read.ts`'s revival placement.

## Verification gate (run in this order before claiming done)

```bash
pnpm run typecheck && pnpm -r test && pnpm run build && pnpm run lint && pnpm run format:check
```

Plus: two Lighthouse runs against `https://deptend.vercel.app/` (post-deploy or against
a preview URL) both passing 2500 ms / 80, JSONs attached to the PR/ADR.
