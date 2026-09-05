# D1: Re-ingest dev branch to test the testable claim

**Date:** 2026-09-04
**Goal (from `score-divergence-root-cause.md`):** verify that re-running the
ingestion pipeline against the dev Neon branch with `LIBRARIES_IO_API_KEY`
present in the shell produces a row in `mission_scores` for
`GHSA-www2-v7xj-xrc6` matching the prod branch's `composite_score = 9.6`,
`impact_score = 9.8`, `ecosystem_value_score = 9.4`, `downstream_dependents = 112450`,
`confidence = "medium"` (1 flag).

**Result: the claim holds. All 6 status=complete repos on the dev branch
re-ingested cleanly; the urllib3 mission on dev now matches prod byte-for-byte
in `mission_scores`; and the live dev `/missions` page (post `unstable_cache`
TTL) shows the same `9.6/10` score, the same PYSEC-2023 second row, and the
same absence of "low confidence" on every re-ingested mission.**

## Method

1. Confirmed `LIBRARIES_IO_API_KEY` is set in `.env.local` and read by
   `scripts/ingest.js:124` via `process.env["LIBRARIES_IO_API_KEY"]`.
2. Hit a pre-existing latent bug: Node 22.23 ESM rejects the static
   `import { parse } from '@yarnpkg/lockfile'` pattern used throughout
   `packages/core/src/ingestor/yarn-lock-parse.ts`, even though the dep's
   own `module.exports.parse = parse` makes it work fine in CJS. Direct
   `node scripts/ingest.js` exits with `SyntaxError: Named export 'parse'
   not found`. Worked around with a small `node:module` loader hook
   (`scripts/_loader-yarn-lockfile-fix.mjs` + `scripts/patch-yarn-lockfile.mjs`)
   that re-exposes the named exports via `createRequire`. Not committed
   to source. Local-only, lives in `scripts/` next to the script it
   enables. This is **the same family of issue as the known pnpm/Node
   ESM-CJS interop surprises already documented in AGENTS.md §12**, and
   the parallel "code complexity reduction" session is the right place
   to land the proper fix (likely: switch the import to a dynamic
   `import()` or move the file to `.mts`). Did not touch it.
3. Drove the ingest via the ADR 0023 documented local path:
   `node --env-file=.env.local --import=./scripts/_loader-yarn-lockfile-fix.mjs \
    scripts/ingest.js --triggered-by manual --repo-id <uuid>`
   against the dev branch's pooled endpoint (`ep-curly-meadow`).
4. Ran on one repo (`psf/requests`) first to confirm the shape, then the
   remaining 5 status=complete repos. Skipped the 3 `skipped` repos
   (`Bagong-Enerhiya`, `Torque2D`, `sherlock`). They have no manifest
   and the resolver would re-skip them anyway.
5. Verified the DB state by direct query against both endpoints, then
   restarted the dev app and waited 65 s for `unstable_cache` (60 s TTL)
   to expire, then re-snapshotted `/missions` in ego-browser.

## Per-repo ingest run (dev branch)

| repo (owner/name) | UUID prefix | deps | advisories | missions (created/updated) | notes |
| --- | --- | --- | --- | --- | --- |
| psf/requests | `6f029c0d` | 6 | 48 | 0/51 | the 9.0 → 9.6 case |
| SpIob/FlowState | `5dd9ef96` | 66 | 51 | 43/32 | dep count jumped 26 → 66 |
| SpIob/StockWatch | `7d22e6c5` | 82 | 87 | 87/29 | dev-only repo, prod doesn't have it |
| SpIob/deptend-go-test-fixture | `0dd5acdd` | 2 | 58 | 3/55 | |
| SpIob/deptend-nullrepo-test-fixture | `3e85d872` | 1 | 2 | 0/2 | dev-only |
| SpIob/deptend-pypi-test-fixture | `ce0de2e0` | 1 | 8 | 0/8 | dev-only |

All 6 ran exit 0. Wall time: ~3 min total. The warnings logged are all
OSV's "no CVSS score or severity level found for advisory PYSEC-…"
variants, which are data truth. Those advisories really don't carry a
CVSS in OSV. No code errors, no GitHub rate-limit errors, no libraries.io
rate-limit errors. The free-tier `LIBRARIES_IO_API_KEY` was accepted
silently (no startup warning).

## Direct DB evidence

### Table-level before/after on the dev branch

| metric | dev (before) | dev (after) | prod (untouched) |
| --- | --- | --- | --- |
| repos total / complete | 9 / 6 | 9 / 6 | 4 / 3 |
| advisories total | 145 | 209 | 146 |
| **advisories with cvss_score** | **0** | **132** | 81 |
| missions total | 197 | 310 | 141 |
| missions at confidence="medium" | 0 | 128 | 33 |
| missions at confidence="low" | 197 | 182 | 108 |

Why 209 dev advisories vs 146 prod: the 6 dev-only repos that prod never
had (`StockWatch`, `Torque2D`, `sherlock`, `deptend-pypi-test-fixture`,
`deptend-nullrepo-test-fixture`, plus `FlowState` having 26→66 deps) and
the three new repos that prod-side hasn't picked up since 2026-08-30.
The dev branch is now strictly more populated than prod for advisories
that have CVSS in OSV, which is what the new code path extracts.

### The 9.0 vs 9.6 mission, before/after

| column | dev (before) | dev (after) | prod (target) |
| --- | --- | --- | --- |
| `advisories.cvss_score` | null | **9.8** | 9.8 |
| `mission_scores.composite_score` | 9.0 | **9.6** | 9.6 |
| `mission_scores.impact_score` | 9.0 | **9.8** | 9.8 |
| `mission_scores.ecosystem_value_score` | 9.1 | **9.4** | 9.4 |
| `ecosystem_value_inputs.downstream_dependents` | null | **112450** | 112450 |
| `ecosystem_value_inputs.repo_stars` (psf/requests) | 54250 | 54277 | 54266 |
| `mission_scores.confidence` | "low" | **"medium"** | "medium" |
| `confidence_flags` count | 4 | **1** | 1 |
| `confidence_flags` (only one set) | (4) | **`{no_lock_file: true}`** | `{no_lock_file: true}` |

The composite math (`impact × 0.6 + ev × 0.4`) checks out:
- dev after: `9.8 × 0.6 + 9.4 × 0.4 = 5.88 + 3.76 = 9.64` → **9.6** ✓
- prod:      `9.8 × 0.6 + 9.4 × 0.4 = 5.88 + 3.76 = 9.64` → **9.6** ✓
- dev before: `9.0 × 0.6 + 9.1 × 0.4 = 5.4 + 3.64 = 9.04` → **9.0** ✓

## Live dev page (post-TTL)

Snapshot of `http://localhost:3000/missions` after the 60s `unstable_cache`
TTL elapsed, top-of-board urllib3-related rows (verbatim from ego-browser):

```
▸ CRITICAL PYPI Vulnerability Fix Update urllib3 to fix a critical vulnerability(GHSA-www2) Fix: 1.23 Low effort · psf/requests 9.6/10
▸ HIGH    PYPI Vulnerability Fix Update urllib3 to fix a high vulnerability(PYSEC-2023) Fix: 2.0.6 Medium effort · psf/requests 8.6/10
▸ HIGH    PYPI Vulnerability Fix Update urllib3 to fix a high vulnerability(GHSA-q2q7) Fix: 1.26.5 Trivial effort · psf/requests 8.3/10
▸ HIGH    PYPI Vulnerability Fix Update certifi to fix a high vulnerability(GHSA-xqr8) Fix: 2023.7.22 Low effort · psf/requests 8.3/10
```

Side-by-side with prod's verbatim snapshot from the prior
`2026-09-04-prod-vs-dev/summary.md`:

| rank | dev (now) | prod |
| --- | --- | --- |
| 1 | urllib3 critical, 1.23, **9.6/10** | urllib3 critical, 1.23, **9.6/10** |
| 2 | urllib3 PYSEC-2023, 2.0.6, **8.6/10** | urllib3 PYSEC-2023, 2.0.6, **8.6/10** |
| 3 | urllib3 GHSA-q2q7, 1.26.5, **8.3/10** | urllib3 GHSA-q2q7, 1.26.5, **8.3/10** |
| 4 | certifi GHSA-xqr8, 2023.7.22, **8.3/10** | certifi GHSA-xqr8, 2023.7.22, **8.3/10** |

Order, score, ecosystem, fixed version, effort label, and the absence
of "low confidence" text all match.

## What this proves and what it doesn't

**Proves:**
- The scorer is correct: same inputs → same output, on both branches.
- The 9.0/9.6 split was a data-state drift between two Neon branches,
  not a code regression.
- The "every prod card hides 'low confidence', every dev card shows it"
  UI behavior from the prior report is correctly driven by the underlying
  data: re-ingest a dev mission and it stops showing "low confidence"
  without any UI change.
- The libraries.io prefetch works end-to-end against the dev branch
  with the local `.env.local` key.

**Does NOT prove:**
- The dev branch's `advisories` table is now a strict subset of prod's.
  Dev has 209 advisories to prod's 146 because dev has 5 repos prod
  doesn't. Cleaning those up is the "existing polluted data" runbook
  in ADR 0023's second addendum, not a goal of D1.
- The Drizzle `neon-http` driver can fetch the new rows through the
  `getDb()` singleton. (The dev app did serve them on the post-TTL
  snapshot, so this is implicitly confirmed, but a re-verification
  against the post-`tsc --noEmit` rebuild might be a separate decision
  point.)
- A future cron run on dev would do the same. The local path
  (`scripts/ingest.js` with `--triggered-by manual`) and the cron path
  (`workflow_dispatch` → the same `ingest.js` with `--triggered-by
  cron`) share the writer. A cron-mode run with `REINGEST_STALE_DAYS=0`
  would re-pick the same 6 repos by the same `resolveDueRepos()`
  resolution path (line 558 of `scripts/ingest.js`); verifying that
  end-to-end is a separate decision.

## Status of pre-existing items

- **D2: `scripts/backfill-orgs.mjs` env-var bug** (reads `DATABASE_URL`
  instead of `DATABASE_URL_UNPOOLED`): **still open**, untouched by D1.
  Same priority as before; the 2026-08-30 backfill log in
  `reports/perf/2026-08-30/round-5-fixed/backfill-log.md` documents it.
- **D3 — `LIBRARIES_IO_API_KEY` in prod Actions**: **still open**,
  untouched by D1. The 65 prod advisories that still have `cvss_score`
  null are explained by this. The next prod cron after the key is
  configured should re-extract them.

## Side artifact: local-only ESM loader hook

Two files were added under `scripts/` to make `node scripts/ingest.js`
work on this developer's machine. They are explicitly **not part of
the runtime path**:

- `scripts/_loader-yarn-lockfile-fix.mjs`: the `--import=` entry point
- `scripts/patch-yarn-lockfile.mjs`: the loader hook body

Both are written in the simplest way that solved the immediate problem.
The right permanent fix is a small source change in
`packages/core/src/ingestor/yarn-lock-parse.ts` (e.g. switch to
`import("@yarnpkg/lockfile")` or rename to `.mts`), and that's a
deliberate decision for the parallel "code complexity reduction" session
to own. Flagging it here so they can pick it up cleanly if they want.
If the parallel session is also planning to touch the ingestor, leaving
the workaround files in place for a one-off D1 verification is fine;
they can be deleted in the same commit as the real fix.
