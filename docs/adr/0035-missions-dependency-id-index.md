# ADR 0035 — Index `missions.dependency_id` + bulk mission-existence check

**Status:** Proposed
**Date:** 2026-08-25

---

## Context

`MissionWriter.generateMissionsForRepo()` resolves which of a repo's candidate
(dependency, advisory) pairs already have a mission — the manual check-then-write
`missions` requires since it has no unique constraint (ADR 0008 §2). Two problems
in how that check ran:

1. **No index on `missions.dependency_id`.** The missions table carried indexes on
   repo_id, status, mission_type, and advisory_id (migration `0000`) — but not the
   dependency half of the pair, even though every lookup filters on it. Same class
   of gap ADR 0034 closed on `dependencies`.
2. **One existence SELECT per candidate.** The check ran inside the write loop —
   N serial round trips per repo per ingestion run, each holding the Neon
   WebSocket transaction open longer than it needs to.

## Decision

Two halves, deliberately kept in step:

**Migration `0006_add_missions_dependency_id_index.sql`**, generated from schema.ts
via drizzle-kit:

```sql
CREATE INDEX "idx_missions_dependency_id" ON "missions" USING btree ("dependency_id");
```

**One bulk existence query.** `selectExistingMissionIds()` replaces the per-candidate
SELECT: a single `SELECT id, dependency_id, advisory_id WHERE dependency_id IN (…)`
for all of the repo's candidate dependencies, matched to candidate pairs in JS via a
`dependencyId:advisoryId` key. The loop then does only the writes: UPDATE-by-id for
known missions, INSERT for new ones. The bulk query still runs inside the
transaction where the per-candidate check lived, so check-then-write semantics are
unchanged — N round trips became 1, nothing else moved.

Rows whose `dependency_id`/`advisory_id` were nulled by their `ON DELETE SET NULL`
foreign keys can never match a live candidate pair and are skipped explicitly.

## Application status

Applied to **dev** (`DATABASE_URL_UNPOOLED` from `.env.local`) via `pnpm drizzle-kit
migrate` on 2026-08-25, then to **production** the same day during the pre-deploy
window. Production needed one bookkeeping step first: its `__drizzle_migrations`
journal had no row for `0004_yellow_firestar` — the table that migration creates
(`repo_bookmarks`) had been applied out-of-band in the ADR 0027 pass, leaving schema
ahead of journal — so drizzle-kit aborted re-running 0004's non-idempotent
`CREATE TABLE`. Resolved by backfilling 0004's row per the ADR 0026 procedure
(sha256 of the migration file + its meta `when` timestamp), after which a single
migrate run applied `0005` + `0006` cleanly. Verified against production:
both indexes present with correct definitions, journal at six rows (`0001`–`0006`;
`0000` predates migration tooling on every branch), writer-shaped lookup executes.

### Live verification (2026-08-25)

Dev confirms the DDL landed cleanly: `pg_indexes` carries
`CREATE INDEX idx_missions_dependency_id ON public.missions USING btree (dependency_id)`,
and the writer-shaped lookup (`SELECT id, dependency_id, advisory_id WHERE
dependency_id IN (...)`) executes without error. As with ADR 0034's verification,
the planner seq-scans at dev-scale row counts — correct, not a defect: reading a
few heap pages beats index descent until the table crosses the planner's cost
crossover, which is where production's mission count lives. (A session-level
`enable_seqscan = off` proof wasn't possible here: each neon-http request is its
own connection, so the SET doesn't carry to the EXPLAIN.) The DATABASE_URL-gated
live block in `queries.test.ts` executed all three board sort modes against real
dev Postgres as part of this pass.

## What changed

- `packages/core/src/db/schema.ts` — `idx_missions_dependency_id` added to the missions table definition.
- `packages/core/src/db/migrations/0006_add_missions_dependency_id_index.sql` (+ meta snapshot) — the migration.
- `packages/core/src/scorer/writer.ts` — bulk `selectExistingMissionIds()`;
  `upsertMission()` split into `refreshMissionCopy()` + `insertMission()` with no
  read path of its own.
- `docs/data-model/README.md` — schema changelog row.

## Consequences

- One more index to maintain on `missions` writes — same noise-level trade ADR 0034
  accepted for `dependencies`; ingestion is the only writer and is already bulk.
- Ingestion runs hold their per-repo transactions open for roughly one-third the
  previous write-phase duration (N+1 selects → 1 select), which matters because the
  transaction holds a Neon WebSocket connection.
- No behavior change: created/updated counts, copy-refresh-only semantics (ADR 0008
  §3), and outcome shapes are identical.

## Alternatives considered

| Alternative                                                            | Why not                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composite index `(dependency_id, advisory_id)`                         | The advisory half adds selectivity JS matching already provides for free; single-column matches the FK access pattern and stays usable by any future dependency-led query.                                                                            |
| Batch INSERT/UPDATE multi-row statements                               | Bigger rewrite of the loop's per-candidate scoring/copy flow for marginal gain after the N+1 is gone; the score upserts already use one statement per row against a unique-constrained target. Revisit if transaction time ever shows up in practice. |
| Unique constraint on `(dependency_id, advisory_id)` → real ON CONFLICT | Settled decision (§11): `missions` has no unique constraint; changing that needs its own decision point, not a ride-along here.                                                                                                                       |

---

_End of document._
