# Round 5 FIXED: `/org/[org]` actually rendering — anonymous

**Date:** 2026-08-30
**Method:** Re-run of Round 5 from `reports/perf/2026-08-30/round-5/` after the `scripts/backfill-orgs.mjs` backfill populated the `organizations` table and set `repos.org_id` for all 4 known repos.

**Goal:** Confirm the ADR 0047 fix actually works in production, characterize the real `/org/[org]` page performance, and update AGENTS.md §13 to remove the regression.

**Tooling:** Lighthouse 13.4.1 (desktop preset, no synthetic throttling), Chromium headless via Playwright, `curl`, ego-browser for visual confirmation.

## Diagnostic (Phase 1.2)

Three queries against the production branch via the Neon SQL editor (full results in `diagnostic-queries.md`):

- `SELECT * FROM organizations` → **0 rows**. The `organizations` table was empty.
- `SELECT owner, name, org_id FROM repos` → **4 rows, all with `org_id = NULL`**. Confirmed Branch A of the plan.
- `SELECT DISTINCT owner FROM repos` → 2 distinct logins: `SpIob`, `psf`.

This ruled out Branches B, C, and D (writer bug, data normalization, read-path bug). The fix is the one-time backfill.

## Fix (Phase 1.3)

`node scripts/backfill-orgs.mjs` against production. **First run (with the default `DATABASE_URL`) was a silent no-op** because of an env-var bug in the script — see the follow-up section below. Second run, with `DATABASE_URL=$DATABASE_URL_UNPOOLED` explicitly, backfilled 4/4 repos in seconds. Two distinct orgs created: SpIob (3 repos) and psf (1 repo).

Full invocation log in `backfill-log.md`.

## Lighthouse metrics (now measuring the real directory, not the 404 placeholder)

### `/org/SpIob` (3 repos)

| Run | FCP | LCP | TBT | CLS | Doc TTFB (LH) | Perf score | Page bytes |
|---|---|---|---|---|---|---|---|
| Cold | 0.4 s | 0.7 s | 0 ms | 0.009 | 40 ms | 100/100 | 143 KiB |
| Warm-1 | 0.4 s | 0.6 s | 0 ms | 0.008 | 40 ms | 100/100 | 141 KiB |
| Warm-2 | 0.4 s | 0.5 s | 0 ms | 0.008 | 40 ms | 100/100 | 141 KiB |
| Warm-3 | 0.4 s | 0.5 s | 0 ms | 0.008 | 40 ms | 100/100 | 141 KiB |

### `/org/psf` (1 repo)

| Run | FCP | LCP | TBT | CLS | Doc TTFB (LH) | Perf score | Page bytes |
|---|---|---|---|---|---|---|---|
| Cold | 0.3 s | 0.5 s | 0 ms | 0.032 | 40 ms | 100/100 | 141 KiB |
| Warm-1 | 0.4 s | 0.5 s | 0 ms | 0.032 | 40 ms | 100/100 | 140 KiB |
| Warm-2 | 0.3 s | 0.4 s | 0 ms | 0.033 | 40 ms | 100/100 | 140 KiB |
| Warm-3 | 0.3 s | 0.5 s | 0 ms | 0.032 | 40 ms | 100/100 | 140 KiB |

### Comparison: Round 5 (404 body) vs Round 5 FIXED (real directory)

| URL | Metric | Round 5 (404) | Round 5 FIXED (directory) | Δ |
|---|---|---|---|---|
| `/org/SpIob` | LCP | 0.6-0.8 s | 0.5-0.7 s | ≈ same |
| `/org/SpIob` | TBT | 20-50 ms | **0 ms** | -20 to -50 ms |
| `/org/SpIob` | CLS | 0.038 | 0.008-0.009 | -0.030 |
| `/org/SpIob` | Bytes (compressed) | 137-138 KiB | 141-143 KiB | +3-6 KiB (the repo cards) |
| `/org/psf` | LCP | 0.6 s | 0.4-0.5 s | -0.1 to -0.2 s |
| `/org/psf` | TBT | 20-30 ms | **0 ms** | -20 to -30 ms |
| `/org/psf` | CLS | 0.038 | 0.032-0.033 | ≈ same |
| `/org/psf` | Bytes (compressed) | 137-138 KiB | 140-141 KiB | +2-3 KiB (1 repo card) |
| `/org/SpIob` | Uncompressed HTML | 15 525 | 29 460 | +13.9 KiB (3 repo cards) |
| `/org/psf` | Uncompressed HTML | 15 525 | 23 108 | +7.6 KiB (1 repo card) |

**The TBT drop from 20-50 ms to 0 ms is the headline.** Round 5's measurement was of the 404 placeholder, which has more client-side React work (the not-found page hydrates its own layout) than the real org page. The real org page is essentially free client-side; all the work happens server-side, and the client just renders 3-4 simple `RepoCard` components with no JS-heavy interactions.

## curl TTFB probes (10 iters each)

| URL | Median TTFB | TTFB range | Median total | Median bytes |
|---|---|---|---|---|
| `/org/SpIob` (3 repos) | 178 ms | 167-206 ms | 197 ms | 29 460 |
| `/org/psf` (1 repo) | 174 ms | 165-187 ms | 184 ms | 23 108 |

Both are within noise of every other read-path page measured in this test series. The 13-15 KiB HTML delta (29 vs 15) is the cost of 1-3 `RepoCard` components rendered server-side; that is what would have been measured in Round 1 if the page had been working then.

## Visual confirmation via ego-browser

- `/org/SpIob` renders the SpIob header + 3 `RepoCard` entries (Bagong-Enerhiya, FlowState, deptend-go-test-fixture), each with its description, ecosystem badge, severity counts, and star count.
- `/org/psf` renders the "Python Software Foundation" header + 1 `RepoCard` entry (psf/requests) with the same per-repo detail.
- No 404 body, no error-boundary skeleton.

## Follow-up surfaced (separate commit, not in this PR)

**`scripts/backfill-orgs.mjs` line 46 uses `process.env.DATABASE_URL`** — the pooled PgBouncer connection — but the unpooled `DATABASE_URL_UNPOOLED` is what sees the data the script needs to update. The documented usage (`node scripts/backfill-orgs.mjs`) is therefore a silent no-op for any dev environment where the pooled URL routes to a different Neon endpoint than the unpooled URL.

Fix: prefer `DATABASE_URL_UNPOOLED` when set, fall back to `DATABASE_URL`. Same pattern as `drizzle.config.ts` and the `postgres` devDependency. The script's idempotency makes a re-run after the fix safe.

This is a real example of the AGENTS.md §0.1 / §10 issue: the backfill's existence in the codebase read like "the fix is shipped" but it never actually worked. The new "live verification before Accepted" rule in §10 is meant to catch this category going forward; this specific bug pre-dates that rule.

## Updated AGENTS.md §13

The previous §13 entry implied `/org/[org]` was working (Phase 1 was the bug; the fix only sort of landed). The fix is now actually live in production, with verification artifacts. The §13 entry will be removed in the §10/§13 commit (Phase 4 of the plan).
