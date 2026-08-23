# ADR 0034 — Composite index on `dependencies (repo_id, ecosystem)`

**Status:** Proposed
**Date:** 2026-08-23

---

## Context

`getRepoDirectoryBase()` (homepage, every render) runs:

```sql
SELECT DISTINCT repo_id, ecosystem FROM dependencies
```

with no WHERE clause. The only indexes on `dependencies` date from migration `0000`; none lead with the `(repo_id, ecosystem)` pair, so Postgres scans the entire table — the largest one in this schema — and deduplicates. This is the known issue AGENTS.md §13 has carried since the ADR 0031 pass ("a `dependencies(repo_id, ecosystem)` index migration would close it properly"), deferred at then-current scale. The read-path performance pass raised it again because the query sits on the hottest page; Mico approved including it in that pass.

## Decision

Migration `0005_absurd_malice.sql`, generated from schema.ts via drizzle-kit:

```sql
CREATE INDEX "idx_dependencies_repo_ecosystem"
  ON "dependencies" USING btree ("repo_id","ecosystem");
```

The DISTINCT pair is now an index-only scan: Postgres walks the index's leading columns and returns each distinct combination once. Column order matters — `repo_id` first also serves the existing per-repo reads (`getRepoEcosystems()`'s `WHERE repo_id = ?` distinct), while `(ecosystem, repo_id)` would serve neither efficiently.

## Application status

Applied to the **dev branch** (`DATABASE_URL_UNPOOLED` from `.env.local`) via `pnpm drizzle-kit migrate` on 2026-08-23 — additive DDL, no locks beyond the brief index build, no backfill. Production needs the same command against the production unpooled URL during the next deploy window; it is not applied there by this change.

## What changed

- `packages/core/src/db/schema.ts` — `idx_dependencies_repo_ecosystem` added to the dependencies table definition.
- `packages/core/src/db/migrations/0005_absurd_malice.sql` (+ meta snapshot) — the migration.
- `docs/data-model/README.md` — schema changelog row 0.1.6.

## Consequences

- One more index to maintain on `dependencies` writes. Ingestion inserts are bulk and already multi-indexed; the marginal cost is noise against removing a full-table scan from every homepage render.
- The §13 known issue is closed; AGENTS.md updated in the same pass.
- No query text changed, no row types changed, no behavior change — the same result set arrives faster.

## Alternatives considered

| Alternative                                      | Why not                                                                                                                                                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cache the distinct set instead                   | ADR 0033 caches the whole homepage base now, but a 60 s cache over an O(all dependencies) scan still pays the scan once a minute per key; the index makes the query itself cheap and benefits every caller, cached or not. |
| Denormalize ecosystems onto `repos`              | Rejected as settled architecture (AGENTS.md §11): no `repos.ecosystem` column — ecosystem is decided fresh per ingestion run and recorded per-row.                                                                         |
| Rewrite as `GROUP BY` / lateral per-repo queries | Same scan underneath; rewrites shuffle work without removing it.                                                                                                                                                           |

---

_End of document._
