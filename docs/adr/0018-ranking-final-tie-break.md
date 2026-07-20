# ADR 0018 — Ranking Final Tie-Break: published_at Instead of created_at

**Status:** Accepted
**Date:** 2026-07-18
**Phase:** 4 (found while cross-validating the CLI against the live dashboard)

---

## Context

ADR 0017 fixed `rankMissions()`'s transitivity bug by bucketing `composite_score` into fixed-width tiers, with `effort_label` breaking ties within a tier and the mission's own `created_at` as the final, guaranteed-deterministic fallback below that.

Cross-validating the Phase 4 CLI against the live dashboard for `SpIob/StockWatch` — the exact workflow suggested to Mico as the strongest available test, since it runs the same scoring code through two independently-built call paths — surfaced a real discrepancy: a `postcss` mission showed different advisory data (different `osv_id`, different `fixed_version`, different advisory age) between a CLI run and the dashboard. Diagnosis ruled out several plausible explanations before landing on the real one:

- **Not OSV pagination.** A direct `querybatch` call for `postcss` confirmed no `next_page_token` — all 4 of postcss's real advisories come back in one unpaginated response, every time.
- **Not missing/wrong data.** All 4 advisories are legitimate, and (confirmed against a full mission export) all 4 do appear as separate missions on both sides — the earlier screenshots just happened to catch two _different_ individual cards from that set of 4, not the same "slot" disagreeing.
- **The real cause:** of 29 missions in that CLI run, **28 shared both tier and effort_label** with at least one other mission — only the single top-scoring mission was ever uniquely ordered by score+effort alone. The final tie-break was doing essentially all of the real ordering work, and it was silently non-functional.

`analyze.ts` computed one `const now = new Date()` per CLI invocation and reused it as `created_at` for every mission built in that run — so within a single run, the "tie-break" compared identical values and did nothing; final order fell through to whatever order OSV's response (and downstream `Map` iteration) happened to produce.

The more consequential discovery: **the dashboard has the same bug, structurally**, not just a CLI quirk. `missions.createdAt` uses Drizzle's `.defaultNow()`, which is Postgres' `now()` — and `now()` is fixed for the lifetime of a transaction (it's `transaction_timestamp()` under the hood, not `clock_timestamp()`). `MissionWriter.write()` writes an entire repo's missions inside one `db.transaction()`. So every mission created in the same ingestion run gets an identical `created_at` on the DB side too. The tie-break has likely never meaningfully discriminated between missions created together in one ingestion run — which is the normal case, not an edge case.

## Decision

Replace the final tie-break input with **the tied advisory's own `published_at`** (real, per-advisory data, unrelated to when DepTend happened to ingest anything), descending — newest known vulnerability first. Below that, **`osv_id` ascending** as an absolute, always-present, always-unique fallback, for the rare case two advisories share an identical `published_at`, and to handle a null `published_at` gracefully (sorts after any advisory with a known date, rather than arbitrarily jumping the queue).

**Direction (newest-first) was an explicit product decision, not an engineering default** — the alternative (oldest-first, on "it's had more time for exploits to mature" reasoning) is equally defensible. Mico chose newest-first.

`RankableMission.created_at: Date` is replaced with `RankableMission.tie_break: { published_at: Date | null; osv_id: string }`, and both callers updated:

- `db/queries.ts`'s `getOpenMissionsWithScores()` — now sources `tie_break` from `mission.advisory?.publishedAt` / `mission.advisory?.osvId`, falling back to the mission's own `id` for the (currently unused, forward-looking) case of a mission with no advisory at all.
- `cli/src/analyze.ts` — now sources `tie_break` directly from the `advisory` object already in scope, instead of a shared `now`.

## Why not just fix the CLI

The instinct on first finding this was "the CLI fabricates timestamps wrong, fix the CLI." That would have been treating the symptom. The dashboard's `created_at` tie-break was never actually more reliable — it just had more opportunities to accidentally look stable (re-ingestion over time can give some missions genuinely different `createdAt` values across separate transactions, so _some_ repos might show _some_ real discrimination some of the time, purely by chance of ingestion history). Fixing only the CLI would have "solved" the immediate diff while leaving the dashboard's own ordering exactly as arbitrary as it already was for any repo whose missions were mostly created together.

## Consequences

- Not yet applied to the live repo — `Proposed`, pending Mico applying and confirming.
- **Dashboard mission order will change** for any repo with tied missions, once this ships — not a regression, but worth expecting rather than being surprised by. The previous order was never meaningful; this one is.
- No schema change, no migration, no new dependency — `published_at` already exists on `advisories` and is already surfaced in the UI ("Advisory age").
- `getOpenMissionsWithScores()`'s query doesn't need to change — `mission.advisory.publishedAt` was already being fetched by the existing join, just not used for this purpose.

## Testing

`ranking.test.ts`: existing `created_at`-based tests rewritten for the new `tie_break` shape; new tests cover published_at-descending ordering, the osv_id fallback when published_at also ties, and null-published_at handling. Added a dedicated regression test reproducing the actual shape of the bug found (5 missions, same tier, same effort, mixed/duplicate `published_at` values), asserting a stable order regardless of input order. `analyze.test.ts`: new end-to-end test engineering two packages to produce identical `composite_score` and `effort_label`, confirming the real pipeline (not just the isolated ranking function) resolves the tie by `published_at` correctly. Full suite: packages/core 249/249, cli 13/13. `tsc --noEmit` clean in both.

## Free-tier compliance

No new dependency, no new service, no schema migration. Pure algorithm fix, same as ADR 0017.
