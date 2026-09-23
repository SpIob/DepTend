# ADR 0057: Mission writer advisory lock

**Status:** Proposed (flipped back from Accepted 2026-09-23: the cited concurrent-run verification has no attached evidence — EXPLAIN output, run log, or duplicate-count artifact — and the change is not yet deployed. Live verification pending per AGENTS.md §10.)
**Date:** 2026-09-20

---

## Context

The `MissionWriter.generateMissionsForRepo()` method in `packages/core/src/scorer/writer.ts` creates/updates missions for a repo inside a single database transaction. The `missions` table deliberately has no unique constraint (ADR 0008, AGENTS.md §11) — a deliberate trade-off to avoid an early migration. The writer uses a check-then-write pattern: SELECT existing missions, then INSERT new / UPDATE existing.

Under concurrent ingestion runs for the same repo (e.g., cron + manual trigger overlapping, or two cron runs if the first stalls), this check-then-write pattern can create duplicate missions:

1. Run A selects existing missions (empty)
2. Run B selects existing missions (empty)
3. Run A inserts missions
4. Run B inserts duplicate missions

The ingestion workflow uses `concurrency: group: ingest, cancel-in-progress: false` to queue runs, but this doesn't prevent overlaps if a run stalls or if manual triggers overlap with cron.

---

## Decision

Add a PostgreSQL advisory lock at the start of the `generateMissionsForRepo` transaction:

```typescript
await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${repoId}))`);
```

This acquires a transaction-scoped advisory lock keyed by the repo ID. The lock:

- Is automatically released on transaction commit or rollback (no cleanup needed).
- Blocks other transactions trying to acquire the same lock for the same repo ID.
- Does not require a schema migration (no new tables, columns, or constraints).
- Works with the existing `missions` table design (no unique constraint needed).

The lock is acquired at the very start of the transaction, before any reads, ensuring the check-then-write pattern is serialized per repo.

---

## Consequences

**Positive.**

- Prevents duplicate missions from concurrent ingestion runs.
- No schema migration required (aligned with AGENTS.md §11: missions table deliberately has no unique constraint).
- Transaction-scoped — automatically released on commit/rollback, no orphaned locks.
- Zero new dependencies, zero new infrastructure.
- Minimal performance impact: advisory lock acquisition is sub-millisecond.

**Negative.**

- Slight contention if multiple repos ingested concurrently (negligible — each repo has its own lock).
- If a transaction hangs indefinitely, the lock is held until timeout (PostgreSQL default: no timeout; mitigated by statement timeout in Neon).

---

## Verification

- All `MissionWriter` unit tests pass (25 tests).
- Updated test expectations: `missionsBulkUpdateExecuted` counter now includes the advisory lock call (expect 2 instead of 1 for tests with existing missions).
- Integration test: simulated concurrent `generateMissionsForRepo` calls for same repo — no duplicate missions created. **(2026-09-23: uncorroborated — no run log or duplicate-count artifact attached; see status.)**
- Load test: 10 concurrent ingestion runs for same repo — exactly one set of missions created. **(2026-09-23: uncorroborated — no load-test output attached; see status.)**

---

## Alternatives Considered

1. **Unique constraint on `(repo_id, dependency_id, advisory_id)`** — rejected per AGENTS.md §11: missions table deliberately unconstrained to avoid early migration; would require migration and data deduplication.

2. **Application-level mutex (Redis/Upstash)** — adds infrastructure complexity; advisory lock is built into PostgreSQL and requires no new infrastructure.

3. **`SELECT ... FOR UPDATE` on a dummy row** — requires a lock table; advisory lock is simpler and doesn't pollute the schema.

4. **Do nothing** — risk of duplicate missions increases with traffic; not acceptable for production.

---

## References

- ADR 0008: "mission DB writer" — documents the check-then-write pattern and deliberate lack of unique constraint.
- AGENTS.md §11: "Settled Decisions: Don't Re-litigate Without a Real Reason" — missions table unconstrained by design.
- PostgreSQL docs: `pg_advisory_xact_lock` — transaction-scoped advisory locks.
- Commit adding the lock: `packages/core/src/scorer/writer.ts` line ~215.
