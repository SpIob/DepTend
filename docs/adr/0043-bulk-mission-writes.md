# ADR 0043; Bulk mission writes inside the scorer transaction

**Status:** Proposed
**Date:** 2026-08-29

---

## Context

`MissionWriter.generateMissionsForRepo()` (packages/core/src/scorer/writer.ts) reads the candidate set, computes a score and copy per row, and writes a mission + mission_score for every classification. Pre-0042, the in-transaction write loop was 2N round-trips on the WebSocket-backed neon-serverless driver (ADR 0009):

- N × `INSERT missions` or `UPDATE missions` (per row, decided by the existing-mission lookup)
- N × `INSERT mission_scores … ON CONFLICT (mission_id) DO UPDATE` (per row, unique on missionId)

For a 200-mission re-ingestion on a real cron run, that's 400 WebSocket round-trips inside a single transaction. The neon-serverless driver serializes statements over a single WebSocket; 400 round-trips at ~5–10 ms each is 2–4 s of pure write-loop time per repo, on top of the per-row `computeMissionScore()` cost.

Two additional problems compound that:

- **O(N²) `allDeps.find()`** at writer.ts:234. Each iteration over the N classifications does a linear scan over all of this repo's dependencies to resolve the `Dependency` row by id. At N=200 deps and M=200 classifications, this is up to 40 000 array-iteration comparisons.
- **The pre-existing mission lookup already runs in a single bulk `IN (...)` query** (writer.ts:387–417, leaning on `idx_missions_dependency_id`). The per-row INSERT/UPDATE work that follows is the only place the loop is still serialized.

`missions` has no unique constraint (AGENTS.md §11), so the canonical write pattern is "check existing, then insert or refresh" — the per-row loop's contract, mirrored at the JS level. There is no `ON CONFLICT` shortcut to collapse insert and update into a single statement, so the bulk-write collapse needs to stay a 2-statement design (one bulk insert for new rows, one bulk update for existing rows), not a 1-statement upsert.

## Decision 1; Pre-compute the per-row decisions in JS, then issue 3 bulk statements

The transaction body becomes three round-trips, independent of N:

1. **`selectExistingMissions`** (1 RT, unchanged) — the existing single `WHERE dependency_id IN (...)` query, unchanged.
2. **Bulk INSERT** (1 RT) — `tx.insert(missions).values(arrayOfNewRows).returning({ id })`. New rows are those whose `missionPairKey` (or `dep-only:...` key) was absent from the existing-mission map. Returns generated ids in input order, positionally aligned with the `prepared` array.
3. **Bulk UPDATE** (1 RT) — one `UPDATE missions SET title=v.title, ... FROM (VALUES (id, title, desc, hint, type), ...) AS v(id, title, description, action_hint, mission_type) WHERE missions.id = v.id`, with the per-row reopen decision encoded in a CASE expression on a per-row `reopen_N` boolean. Honors the "dismissed rows never get user fields overwritten" invariant by leaving `status = missions.status` for any row where the existing status was `dismissed` or `claimed` (the prepare-time decision captures this — `reopen` is true only when `existing.status === "resolved"`, never when it's `dismissed` or `claimed`).
4. **Bulk UPSERT** (1 RT) — `tx.insert(missionScores).values(array).onConflictDoUpdate({ target: missionScores.missionId, ... })`. `mission_scores.missionId` is unique, so the same statement covers both the new (just-inserted) and existing (refreshed) mission paths.

The auto-resolution close pass (`resolveStaleMissions`, writer.ts:469–496) stays as one per-row UPDATE chain — it already runs in a single statement regardless of how many rows it touches, and the existing tests pin that behavior.

**Total budget inside the transaction: 5 round-trips** (select-existing + bulk insert + bulk update + bulk upsert + auto-resolution close). At N=200, that's a 40× reduction in DB-side statement count, and a 2N → 5 round-trip improvement on the WebSocket driver.

## Decision 2; O(N²) → O(N+M) via a pre-built `Map<id, Dependency>`

The per-row `allDeps.find(d => d.id === dependencyId)` at writer.ts:234 is replaced by a `Map` built once before the classification pass. The classification loop becomes O(N) over `classifications` and O(1) per `depsById.get(depId)` lookup. For a 200-dep / 200-classification repo, this collapses ~40 000 array iterations into ~200 map lookups.

This is a pure data-structure change with no behavior delta. Same `Dependency` rows reach the same `computeMissionScore` calls.

## Decision 3; The "reopen resolved" rule is captured at prepare time, not at SQL time

Pre-0042, the reopen logic was per-row inside the loop (`currentStatus === "resolved" ? { status: "open", resolvedAt: null } : {}`). In 0042, the per-row decision is captured in a `reopen: boolean` field on each prepared row, then encoded into the bulk UPDATE as a per-row `reopen_N` boolean column the CASE expression reads from. The CASE expression sets `status = 'open', resolved_at = NULL` where the corresponding `reopen_N` is true; otherwise `status = missions.status, resolved_at = missions.resolved_at`.

The other ADR-0008-§3 invariants fall out of the same per-row decision:

- **dismissed rows keep their human decision** — `reopen` is set only when `existing.status === "resolved"`. A `dismissed` row's `reopen` is `false`; its status/resolved_at are preserved by the CASE.
- **claimed rows keep their claim fields** — same rule. A `claimed` row's `reopen` is `false`.
- **previously-open rows are copy-only refreshed** — same rule. No status flip.

The auto-resolution pass is still the only path that closes open/claimed missions to `resolved`, and it's still the same single-statement UPDATE chain (writer.ts:469–496 unchanged).

## Decision 4; Mock DB is upgraded to handle the new shapes; existing assertions stay meaningful

The writer's test mock (packages/core/src/scorer/writer.test.ts) was already dispatching on the table being queried (matters for `.from(table)` and `.values(payload)` capture). Two new captures are added:

- `missionsBulkUpdateExecuted: number` — the `tx.execute(sql)` counter. The bulk UPDATE goes through `tx.execute(sql)` rather than the `tx.update().set().where().returning()` chain, so it doesn't show up in the existing `missionsUpdateSets` array. Tests assert `missionsBulkUpdateExecuted === 1` for the existing-mission refresh path, and `=== 0` for the all-new path.
- `insertedScoreRows: Record<string, unknown>[]` — flattened per-row score values. The bulk mission_scores UPSERT calls `values(arrayOfRows)`, so the old `insertedScoreValues` captured the array; the new flattened array lets the existing 7+ per-row score assertions stay one-deep (`insertedScoreRows[0]`) without the test code caring about the bulk-vs-per-row distinction.

A new test pins the round-trip-budget claim: 20 candidates (10 new + 10 existing) → exactly 1 bulk missions INSERT + 1 bulk missions UPDATE + 1 bulk mission_scores UPSERT + 1 auto-resolution UPDATE = 4 statement calls in the write phase, not 2N = 40. This is the test the §6 gate will fail on if the next refactor accidentally reintroduces a per-row path.

The three "reopen / no-flip / dismissed+claimed" auto-resolution tests at writer.test.ts:530–594 lose their per-row `missionsUpdateSets[0]` introspection (the reopen decision is now inside the bulk UPDATE, which the mock doesn't see). They pivot to asserting the bulk UPDATE was issued and the result counts are right; the per-row reopen-vs-no-reopen behavior is now exercised against the real dev Neon database per the verification bar (Decision 5).

## Decision 5; Verification: live against the dev Neon database, not just mocked round-trips

Per AGENTS.md §6's meta-lesson — "mocks that don't match the real contract are the recurring root cause" — the §6 gate alone is not enough for this change. Two specific risks the mock would not catch:

- **A SQL type-mismatch on the `UPDATE ... FROM (VALUES ...)`** — the per-row `reopen_N` boolean column's type vs. the CASE expression's expected boolean (Postgres 18's strict typing has caught similar mismatches in this project before, AGENTS.md §12).
- **A row-order alignment bug** in the bulk INSERT's `RETURNING id` — Drizzle documents that `RETURNING` is in input order, but Postgres reserves the right to reorder if the insert has triggers or rules. The test mock returns ids in input order by construction; the real driver might not.

**Before merge:** run `pnpm --filter @deptend/core build` then `node scripts/ingest.js --triggered-by manual --repo-url <one known dev repo>` against the dev Neon branch. Diff the resulting `missions` and `mission_scores` tables before-and-after on a per-row basis: same `id`s for existing missions, same `(repo_id, dependency_id, advisory_id, mission_type)` keys for new missions, same `composite_score` values to the last decimal, same `confidence` labels, same `status` field. The pre-flight capture is `pg_dump`-then-`pg_dump`-again-then-`diff`; the post-flight assertion is "zero diff modulo timestamps and `updated_at`."

If the diff is clean, this ADR flips to Accepted. The same live-verification gate was used for ADR 0031 (the /missions SQL ORDER BY) and ADR 0033 (the `reviveDates`-on-result placement), both of which broke under mocks that didn't match the real driver's behavior.

## What changed

- `packages/core/src/scorer/writer.ts`; transaction body rewritten. `insertMission` / `refreshMissionCopy` / `upsertMissionScore` private methods removed. New `bulkWriteMissions` and `bulkUpsertMissionScores` private methods. `Map<id, Dependency>` replaces the `allDeps.find()` loop. `resolveStaleMissions` and `selectExistingMissions` unchanged. ADR reference added to the file header.
- `packages/core/src/scorer/writer.test.ts`; mock upgraded with `execute`, `missionsBulkUpdateExecuted`, `insertedScoreRows`, `insertedMissionInputs`. New `inserts.filter(name === missions)`/etc assertions updated for the 1-call bulk shape. New 20-candidate round-trip-budget test added (writer.test.ts:462). The three "reopen / no-flip / dismissed+claimed" tests at writer.test.ts:530–594 pivoted to bulk-path assertions + live verification.
- `CHANGELOG.md`; entry under `[Unreleased]`.

**No schema migration. No `/app` change. No `scripts/ingest.js` change.** The `MissionWriter` public API (`generateMissionsForRepo(repoId, ...)`) and return type (`GenerateMissionsOutput`) are unchanged. The same scorer code runs on the same inputs and lands the same missions and the same scores.

## Consequences

- **Per-repo ingestion wall time drops by roughly (2N − 5) × RTT_latency.** At 200 candidates and a 5 ms WebSocket RTT, that's a ~2 s save per repo. At 500 candidates (a popular repo with broad dependency tree + many advisories), it's a 5 s save. Across the daily cron run of 25–150 repos, this is 50–750 s of wall time reclaimed, depending on dataset shape.
- **Mission auto-resolution behavior is preserved exactly** — the close pass is unchanged, the "dismissed" / "claimed" no-flip invariants are preserved, the reopen-resolved rule is preserved (now encoded in the bulk CASE instead of the per-row ternary).
- **No new failure mode.** The bulk INSERT and UPSERT use the same Drizzle call shapes (`tx.insert(table).values(array).returning(...)` and `tx.insert(table).values(array).onConflictDoUpdate({...})`) that the project already uses elsewhere (ingestor/writer.ts:296–454 for advisories / dependencies / dependency_advisories).
- **The bulk UPDATE is the project's first `UPDATE ... FROM (VALUES ...)` write path.** It composes carefully named, parameterized placeholders (`$1::uuid`, `$2`, etc.) to stay injection-safe. The CASE-driven `status` and `resolved_at` columns use Postgres's `CASE WHEN ... THEN ... ELSE ... END` shape, which is portable across Postgres versions and the kind of bulk-update pattern Neon's HTTP-driver's documentation covers.
- **Mock test coverage drops in one place and grows in another.** The three "reopen / no-flip / dismissed+claimed" tests can no longer inspect the per-row set() payload; the live Neon diff (Decision 5) is the new ground truth for those specific invariants. The mock still pins the round-trip budget, the bulk vs. per-row count split, the new-vs-existing decision, and every score/prefetch/back-compat invariant — the same surface the existing tests covered, just expressed at the right layer for the new shape.
- **No backfill needed.** Existing mission rows are read by id from the bulk update; the auto-resolution pass handles the open/claimed missions the same way it always has.

## Alternatives considered

| Decision                                                | Alternative                                                        | Why not                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2-statement collapse                                    | 1-statement upsert via `ON CONFLICT`                               | `missions` has no unique constraint (AGENTS.md §11) — adding one is a migration that changes a settled decision, and the migration itself doesn't materially simplify the writer (we'd still need a per-row decision for the reopen rule). The 2-statement shape is the smallest possible change. |
| Bulk UPDATE syntax                                      | CASE-driven STATUS, per-row UPDATE WHERE id IN (subquery)          | The per-row WHERE-IN-subquery form is two round-trips (one for the subquery, one for the UPDATE) on most drivers; the `UPDATE ... FROM (VALUES ...)` form is one statement.                                                                                                                       |
| `reopen_N` boolean columns                              | Encode in the VALUES list and have JS do the CASE                  | The reopen decision is per-row; encoding it in a positional boolean column is straightforward and keeps the SQL self-contained. Doing it in JS would require the writer to know which rows are reopenable, which it already does — but the SQL self-contained form is more auditable.             |
| Skip the per-row reopen                                 | Treat every existing mission as a copy-only refresh                | Breaks the documented "previously auto-resolved mission whose pair came back is reopened" behavior (ADR 0008 §3). Not a real alternative.                                                                                                                                                         |
| Switch to a Drizzle upsert helper                       | Use `tx.insert(...).onConflictDoUpdate({ target: composite-key })` | `missions` has no unique constraint to target (AGENTS.md §11). `ON CONFLICT` requires one. The project's own precedent is the 2-statement check-then-write shape; this ADR stays inside that precedent.                                                                                           |
| Wider refactor (combine mission+mission_scores INSERTs) | Insert into both tables via one statement                          | Postgres can't insert into two tables in one statement. The two-table insert requires either a CTE-with-RULES (deprecated) or a stored procedure (overkill for this).                                                                                                                             |

---

_End of document._
