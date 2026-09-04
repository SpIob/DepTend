# /missions score divergence (9.0 vs 9.6) — root cause

**Date:** 2026-09-04
**Symptom (from `2026-09-04-prod-vs-dev/summary.md`):** the rank-1 mission
(`GHSA-www2-v7xj-xrc6`, urllib3 on `psf/requests`) shows `9.0/10` on the
local dev app but `9.6/10` on `deptend.vercel.app`. Same advisory, same code,
two scores.

**Verdict:** not a bug. The dev and prod Neon branches carry different data
for the same `osv_id`, and the difference is exactly what ADR 0023
(`dev-prod-database-separation.md`) says it should be: two branches, two
data states, no shared writes. The `9.0` and `9.6` values are the
self-consistent result of each branch's own `advisories` and `mission_scores`
rows, computed at the time of each branch's own last ingest.

## Direct DB evidence

Run from `packages/core/` via `postgres` against the two Neon endpoints
configured in `.env.local`:

### `advisories` row for `GHSA-www2-v7xj-xrc6`

| column            | dev (`ep-curly-meadow`) | prod (`ep-solitary-frost`) |
| ----------------- | ----------------------- | -------------------------- |
| severity          | critical                | critical                   |
| cvss_score        | **null**                | **9.8**                    |
| fixed_version     | 1.23                    | 1.23                       |
| published_at      | 2018-12-12              | 2018-12-12                 |
| modified_at       | 2024-12-27              | 2024-12-27                 |

### `mission_scores` row for the same mission

| column                            | dev                       | prod                            |
| --------------------------------- | ------------------------- | ------------------------------- |
| composite_score                   | **9.0**                   | **9.6**                         |
| impact_score                      | 9.0                       | 9.8                             |
| ecosystem_value_score             | 9.1                       | 9.4                             |
| effort_label                      | low                       | low                             |
| confidence                        | **low** (4 flags)         | **medium** (1 flag)             |
| scoring_version                   | 1.1.0                     | 1.1.0                           |
| impact_inputs.cvss_score          | null (fallback)           | 9.8 (real)                      |
| impact_inputs.severity            | critical                  | critical                        |
| ecosystem_value_inputs.downstream | **null**                  | **112,450**                     |

### Whole-table summary

| metric                                          | dev branch | prod branch |
| ----------------------------------------------- | ---------- | ----------- |
| total advisories                                | 145        | 146         |
| **advisories with cvss_score populated**        | **0**      | **81**      |
| last complete ingestion_run                     | 2026-08-22 | 2026-08-30  |
| advisories with downstream_dependents populated | 0          | 81          |

## How the numbers arise

`packages/core/src/scorer/impact.ts:91-105` (DefaultImpactScorer):

```ts
const base = inputs.cvss_score ?? severityFallbackScore(inputs.severity);
let score = base * depTypeWeight(inputs.dep_type);
if (inputs.epss_score != null) {
  score *= 1 + inputs.epss_score * EPSS_BOOST_FACTOR;
}
if (inputs.is_transitive) {
  score *= UNCONFIRMED_TRANSITIVE_DISCOUNT;
}
return { score: clamp(score, 0, 10), inputs };
```

`severityFallbackScore("critical") = 9.0` (line 33). So with `cvss_score = null`,
`impact = 9.0 × 1.0 (production) × 1.0 (no EPSS) × 1.0 (not transitive) = 9.0`.

`packages/core/src/scorer/mission-scorer.ts:578`:

```ts
const composite_score = clamp(impactResult.score * 0.6 + ecosystemValueResult.score * 0.4, 0, 10);
```

- dev: `9.0 × 0.6 + 9.1 × 0.4 = 5.4 + 3.64 = 9.04` → **9.0** (displayed to 1 dp)
- prod: `9.8 × 0.6 + 9.4 × 0.4 = 5.88 + 3.76 = 9.64` → **9.6** (displayed to 1 dp)

Both numbers are internally consistent with each branch's own
`advisories.cvss_score` row. The scorer is correct; the data is just
in a different state.

## Why the branches diverge

ADR 0023 (2026-07-25) deliberately split the database into two Neon
branches so that repos submitted via `localhost:3000` never land on the
public mission board. The trade-off documented in that ADR (§"Consequences",
line 39) is exactly what we see here:

> The `dev` branch will drift from production's schema unless migrations
> are applied to both going forward; worth remembering next time a schema
> migration ships, given Phase 5's and Phase 6's own migration-tooling
> hurdles (ADR 0021, ADR 0022) already showed `drizzle-kit migrate` has
> real quirks in this project even against one branch.

The drift on display here is **not** a schema drift — migrations are in sync
(both branches have 145/146 advisories, both have all the same tables). It's
**data drift** caused by ingestion runs on different schedules hitting each
branch. Specifically:

- **Dev branch** was last ingested on **2026-08-22**. The CVSS-V3→numeric
  extraction path in `packages/core/src/ingestor/osv.ts:478-481` and the
  libraries.io downstream prefetch in `scripts/ingest.js` were either not
  yet landed, not yet hitting this branch, or running without the
  `LIBRARIES_IO_API_KEY` env var on that day. Hence `cvss_score = null`
  for every advisory and `downstream_dependents = null` for every mission.
- **Prod branch** was last ingested on **2026-08-30**, eight days later,
  with the current code. 81 advisories have CVSS populated, 81 missions
  have downstream dependents populated.

Confidence matches the same picture: dev has 4 flags set (no_lock_file,
cvss_score_missing, downstream_dependents_unavailable,
breaking_change_signals_unavailable) → `"low"` per
`deriveConfidence()` (line 513-518: 2+ flags → low). Prod has only
`no_lock_file` → `"medium"`. AGENTS.md §11 already notes that pre-ADR-0032
docs overclaimed `"medium"`; the dev branch's state is the
pre-ADR-0032 / pre-CRSS-V3-extraction era.

## Implications

1. **No code change is needed.** The scorer, the read query, and the
   schema are all behaving as designed. The number 9.0 on the dev branch
   is correct given the dev branch's `cvss_score` column is `null`.

2. **The dev branch needs a fresh ingest** to bring it back to parity
   with prod. The local-only ingestion path
   (`node --env-file=.env.local scripts/ingest.js --repo-id <uuid>
   --triggered-by manual`, per ADR 0023's addendum) re-runs the writer
   for one repo at a time. To bring the whole dev branch up to the prod
   state would mean re-ingesting every repo with `LIBRARIES_IO_API_KEY`
   set in the local shell environment — the libraries.io prefetch is
   what populates `downstream_dependents`, and that key is currently
   absent from `.env.local`.

3. **The "confident" conclusion from §11 of AGENTS.md is now
   empirically testable:** run a fresh ingest on the dev branch, then
   re-query; the dev `confidence` column should drop to "medium" (1
   flag: `no_lock_file`), composite should match prod, and the
   "low confidence" text on every dev card should disappear from cards
   that hit all four flag-clearing conditions. AGENTS.md §11's claim
   that "every card" should show low confidence becomes "every card
   that's been ingested with `LIBRARIES_IO_API_KEY` present" — a
   per-ingest-run claim, not a per-mission claim. Whether to test
   that against the dev branch is a separate decision; per §0 rule 3
   (new dependency, schema migration, etc. is a decision point), this
   one isn't either.

4. **Confidence text on prod** (the "shows 'low confidence' on every dev
   card but only some prod cards" gap from the prior summary) is a
   **separate real bug**, unrelated to the score divergence. On prod,
   `confidence = "medium"` is the actual value, and the UI correctly
   hides the "low confidence" text for medium-and-above. The dev UI
   shows "low confidence" because every dev mission's confidence is
   actually low. Both UI states are correct for their own data.

## Follow-up actions (decision points, per AGENTS.md §0 rule 3)

- **D1 — Re-ingest dev branch to verify the testable claim above.**
  Time and date for this is your call; it requires
  `LIBRARIES_IO_API_KEY` in the local shell and at least one repo's
  worth of GitHub API budget.
- **D2 — `scripts/backfill-orgs.mjs` env-var bug** (from the prior
  session's backfill-log.md) is **still open** per the report
  (`scripts/backfill-orgs.mjs` line 46 reads `DATABASE_URL` instead
  of `DATABASE_URL_UNPOOLED`). Surfacing here in case you want to
  bundle it with D1; not in scope for this pass.
- **D3 — `GITHUB_TOKEN` absent in production** (AGENTS.md §13 known
  issue) means `POST /api/repos`'s manifest pre-check runs
  unauthenticated. Not the cause of the 9.0-vs-9.6 split, but the
  libraries.io prefetch on the prod cron also depends on
  `LIBRARIES_IO_API_KEY` (Actions env), and that key's absence is
  what produced the 65 advisories on prod that *don't* have CVSS
  populated yet.
