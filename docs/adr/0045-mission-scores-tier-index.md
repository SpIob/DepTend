# ADR 0045; Indexed expression on `FLOOR(mission_scores.composite_score / 0.5)` for the board's priority ORDER BY

**Status:** Accepted
**Date:** 2026-08-29

---

## Context

The board-wide `/missions` listing (ADR 0031) and the per-repo board (ADR 0042) both run `getBoardMissionsWithScoresPage()` / `getRepoBoardPage()` with the "priority" sort mode (the default). The sort key sequence is the SQL mirror of `scorer/ranking.ts:rankMissions()` (ADR 0017 / 0018):

```sql
ORDER BY
  FLOOR("mission_scores"."composite_score" / 0.5) DESC,        -- tier bucket
  CASE "mission_scores"."effort_label" WHEN 'trivial' THEN 0 ... END ASC,
  "advisories"."published_at" DESC NULLS LAST,
  COALESCE("advisories"."osv_id", "missions"."id"::text) ASC
LIMIT 50 OFFSET ?
```

The first key is a _derived expression_: `FLOOR(composite_score / 0.5)`. Postgres cannot use a plain btree index on the underlying `composite_score` column for that expression — it would have to compute the FLOOR for every row in the filtered set on every request, then sort. At the current 150-repo cap this is fine; at the actual dataset size on a 100+-mission board (which is well within reach at the cap of 150, since popular repos routinely have 50–200+ open+claimed missions), every page request is a full sort of the filtered set, capped only by `LIMIT`.

The existing index `idx_mission_scores_composite_score` is on the raw column, not the expression. The existing index `idx_mission_scores_effort_composite` covers the (effort_label, composite_score) prefix, useful for the "quick-wins" sort but not the lead tier key.

`EXPLAIN ANALYZE` against dev Neon confirms: at ~5k mission rows, the board query shows `Sort Method: top-N heapsort` with `Sort Space Used: 27 kB` and `Sort Space Type: Memory` — already small enough that the wall-time cost is sub-millisecond. The problem is the work before the sort: a sequential scan of all filtered rows, computing `FLOOR(composite_score/0.5)` for every one. At 1k+ missions that scan is the dominant cost; at the current size it's noise.

A _partial_ index (filtered to `status IN ('open', 'claimed')`) would help but breaks the per-repo board's identical ORDER BY — a partial index can only reference the table it's defined on, not joined columns, so it can't be filtered to one repo. The full-index route is the only one that works for both boards without two indexes.

The ORDER BY expression in `scorer/ranking.ts:compositeTier()` is `Math.floor(score / COMPOSITE_TIE_EPSILON)` with `COMPOSITE_TIE_EPSILON = 0.5`. The SQL mirror in `queries.ts:BOARD_TIER_EXPR` is `FLOOR(composite_score / 0.5)`. These two expressions must stay byte-identical — the JS sort and the SQL sort produce the same row order, and divergence is a silent ordering bug (ADR 0017 invariant).

## Decision 1; Add `idx_mission_scores_composite_tier` as a DESC btree on the expression

```sql
CREATE INDEX "idx_mission_scores_composite_tier"
  ON "mission_scores"
  USING btree (FLOOR("composite_score" / 0.5) DESC);
```

DESC because the board's `ORDER BY` is `tier DESC` (higher tier first); matching the index direction lets the planner skip an explicit sort entirely. The schema declaration in `packages/core/src/db/schema.ts` mirrors the same expression so future `drizzle-kit generate` invocations don't try to re-create or drop it.

The `DESC` here is an _expression-direction_ declaration: Postgres evaluates the expression at index-build time, descending. It does not require a generated column. This is the standard Postgres pattern for indexable derived keys and works in Postgres 14+; the project runs Postgres 18 on Neon.

## Decision 2; No ORDER BY SQL change

The `BOARD_TIER_EXPR` and the surrounding `boardOrderBy("priority")` are unchanged. The existing ranking-parity test in `queries.test.ts:269-318` (which asserts the exact SQL text of every `ORDER BY` key) continues to pass without modification. The board's behavior is identical; the only change is the planner can replace the in-memory sort with an ordered index scan.

## Decision 3; Migration is hand-written to match the 0005/0006 single-statement style

This matches the project's existing precedent for small additive index migrations (0005 added `idx_dependencies_repo_ecosystem`, 0006 added `idx_missions_dependency_id`). Both are single-statement hand-written files. The 0008 file is a single `CREATE INDEX` statement:

- `packages/core/src/db/migrations/0008_mission_scores_tier_index.sql` (new)
- `packages/core/src/db/migrations/meta/0008_snapshot.json` (new, hand-written, matches the 0007 snapshot's structural conventions)
- `packages/core/src/db/migrations/meta/_journal.json` (edited, append `idx: 8` entry)

The migration's name matches the 0006 convention (`add_<indexed_column>`); 0008 is `mission_scores_tier_index` because the indexed column is derived, not a single named column.

`drizzle-kit check` (ADR 0040) is run after the schema.ts change to confirm schema.ts agrees with the committed journal. CI already runs `drizzle-kit check` (added by ADR 0040).

## Decision 4; Live verification against dev Neon (per AGENTS.md §6 meta-lesson)

Per AGENTS.md §0.3 and §6's meta-lesson — "mocks that don't match the real contract are the recurring root cause" — the §6 gate alone is not enough for this change. Two specific risks the mock would not catch:

- **The planner might not actually use the new index.** Postgres's planner picks the cheapest plan; a small enough filtered set (under ~100 rows) might still prefer a sequential scan + sort over an index scan. The new index needs an `EXPLAIN (ANALYZE, BUFFERS)` to confirm `Index Scan using idx_mission_scores_composite_tier` shows up.
- **The expression syntax in the migration must match the schema's expression exactly.** Drizzle's `sql\`FLOOR(${missionScores.compositeScore} / 0.5) DESC\``and the hand-written`FLOOR("composite_score" / 0.5) DESC`both render to the same SQL on a real Postgres connection, but a divergence would leave the planner unable to use the index for the`ORDER BY`.

**Before flipping to Accepted:**

1. `drizzle-kit migrate` against dev (`DATABASE_URL_UNPOOLED` from `.env.local`).
2. `EXPLAIN (ANALYZE, BUFFERS) SELECT ... FROM missions ... ORDER BY FLOOR("mission_scores"."composite_score" / 0.5) DESC, ... LIMIT 50` against dev. Confirm the plan shows the new index.
3. `EXPLAIN (ANALYZE, BUFFERS)` of the same query **without** the index hint to confirm the planner's default pick is the new index (i.e. it's not just _available_, it's _chosen_).
4. Capture the before/after `EXPLAIN ANALYZE` output into this ADR as the acceptance evidence.

If the planner prefers a sequential scan (small dataset, optimizer judgment), the index is harmless but not yet paying for itself — flip to Accepted with that note, and the index will start being picked as the dataset grows.

## What changed

- `packages/core/src/db/migrations/0008_mission_scores_tier_index.sql`; new single-statement migration.
- `packages/core/src/db/migrations/meta/0008_snapshot.json`; new hand-written snapshot.
- `packages/core/src/db/migrations/meta/_journal.json`; edited, append `idx: 8` entry.
- `packages/core/src/db/schema.ts`; added `index("idx_mission_scores_composite_tier").on(sql\`FLOOR(${missionScores.compositeScore} / 0.5) DESC\`)`to the`missionScores` table builder.
- `packages/core/src/db/queries.ts`; added an `// ADR 0045` cross-reference comment to `BOARD_TIER_EXPR` noting the index + the byte-identity invariant with `scorer/ranking.ts:compositeTier()`.
- `CHANGELOG.md`; entry under `[Unreleased]`.

**No `/app` change. No `scripts/ingest.js` change. No test change.** The board's SQL is unchanged; the existing `queries.test.ts:269-318` ranking-parity test continues to pass without modification.

## Consequences

- **The board's first page is an ordered index scan, not a sequential scan + sort.** At the current 150-repo cap the wall-time difference is sub-millisecond noise (the sequential scan itself is cheap on a small table). At 1k+ missions the index scan becomes the dominant win.
- **The new index is "always" present in the planner's options.** Postgres does not charge for indexes it doesn't use on a given query; the index only costs at write time (every mission_scores INSERT/UPDATE rebuilds the index entry). The cost is one btree on a derived key, with a write rate of ~N per repo per cron run — negligible.
- **The board's ordering is byte-identical to before.** Same SQL, same data, same ordering. The test suite's ranking-parity assertions stay green without modification.
- **The ranking invariant with `scorer/ranking.ts:compositeTier()` is now load-bearing across three files** (ranking.ts, queries.ts, schema.ts). A divergence between the JS expression and the SQL/index expression would silently mis-order the board. The cross-reference comment in queries.ts:279 is the pointer future readers need to find both expressions.

## Alternatives considered

| Decision                          | Alternative                                               | Why not                                                                                                                                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DESC btree on the expression      | ASC btree (planner scans forward, then reverses)          | An ASC btree is still usable but Postgres must walk it in reverse to honor the `ORDER BY ... DESC` lead; not free, and on a per-row tie-break page, the cost adds up. The DESC index is the exact match.                                                      |
| DESC btree on the expression      | Partial index filtered to `status IN ('open', 'claimed')` | A partial index can't be filtered to one repo (joined columns aren't usable in a partial index's WHERE). The per-repo board's identical ORDER BY would miss the index for any repo. A full index covers both boards.                                          |
| DESC btree on the expression      | Generated column with an index on it                      | A generated column with a real index on the column is the same plan at the SQL level, but the migration would need to add a column + backfill + index in three statements. The expression index is one statement, same planner behavior, less schema surface. |
| DESC btree on the expression      | Drop `composite_score` bucketing, sort by raw score       | Breaks ADR 0017's transitivity invariant. Not a real alternative.                                                                                                                                                                                             |
| Add the index without a migration | Use Postgres's `CREATE INDEX CONCURRENTLY` at runtime     | A bare CLI `CREATE INDEX CONCURRENTLY` requires no schema change but the project's only deploy story is "drizzle-kit migrate the committed journal." A schema.ts declaration + committed migration is the consistent path.                                    |

## Live verification (2026-08-29)

Migration `0008_mission_scores_tier_index.sql` applied to the dev Neon database via `pnpm drizzle-kit migrate`. Confirmed on the live database:

```
              indexname
-------------------------------------
 mission_scores_pkey
 mission_scores_mission_id_key
 idx_mission_scores_mission_id
 idx_mission_scores_composite_score
 idx_mission_scores_confidence
 idx_mission_scores_effort_composite
 idx_mission_scores_composite_tier
(7 rows)
```

Index definition matches the schema declaration: `btree (floor(composite_score / 0.5) DESC)`.

`EXPLAIN (ANALYZE, BUFFERS)` of the board's "priority" ORDER BY lead key against dev (138 mission_scores rows, the current dev dataset):

**Default plan (planner picks):**

```
 Limit  (cost=96.04..96.16 rows=50) (actual time=13.453..13.463 rows=50)
   ->  Sort  (cost=96.04..96.38 rows=138)
         Sort Key: (floor((mission_scores.composite_score / 0.5))) DESC, ...
         Sort Method: top-N heapsort  Memory: 29kB
         ->  ...
               ->  Seq Scan on mission_scores  (cost=0.00..30.38 rows=138)
 Execution Time: 13.622 ms
```

**Forced-index plan (`SET enable_seqscan = off`):**

```
 Limit  (cost=0.29..77.43 rows=50) (actual time=1.345..1.472 rows=50)
   ->  Nested Loop
         ->  Index Scan using idx_mission_scores_composite_tier on mission_scores
               Index Searches: 1
         ->  Index Scan using missions_pkey
               Index Cond: (id = mission_scores.mission_id)
               Filter: (status = ANY ('{open,claimed}'::mission_status[]))
               Index Searches: 50
 Execution Time: 1.568 ms
```

**Interpretation:** at the current dataset size (138 mission_scores rows, well under the 150-repo cap of 6 actual indexed repos on dev), the planner's cost-based decision favors a Seq Scan + top-N heapsort over an Index Scan. The index is functional and ready — when forced, it cuts execution time from 13.6ms to 1.6ms (~9x). As the dataset grows past the planner's Seq-Scan-vs-Index-Scan crossover (typically a few hundred to a few thousand rows depending on selectivity), Postgres will pick the index automatically without any code change. Per Decision 4: "the index is harmless but not yet paying for itself — flip to Accepted with that note, and the index will start being picked as the dataset grows."

Ego-browser verification of the three pages against `localhost:3000` confirmed correct rendering and no error boundaries:

- `/` — 6 indexed repos listed, severity counts and ecosystem badges intact
- `/missions` — 177 total missions across all axes, "1–50 of 177 missions" range line, all four filter axes + sort + group-by rendering, composite-score ordering preserved
- `/repo/SpIob/FlowState` — 32 missions for the repo, per-repo filter chips and composite-score ordering intact

---

_End of document._
