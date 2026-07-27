# ADR 0026 — Migration Bookkeeping: `__drizzle_migrations` Backfill and SQL-Editor-First Default

**Status:** Accepted
**Date:** 2026-07-27

---

## Context

`__drizzle_migrations` had fallen 3 records behind reality by the time of the Go ecosystem session: migration `0001` (Phase 5, ADR 0021) confirmed absent, `0002` (Phase 6, ADR 0022) never confirmed either way, `0003` (Go session, ADR 0024) confirmed absent. Each was applied by hand via Neon's SQL Editor after `drizzle-kit migrate` hung on an `ALTER TYPE ... ADD VALUE` statement — now a 2-for-2 pattern (`0001`, `0003`), not a one-off. Left unaddressed, the gap grows every time an enum gets a new value, and the eventual next real `drizzle-kit migrate` run risks either re-attempting already-applied SQL or producing a confusing, partial-looking history table for anyone who inspects it.

## Decision

Two parts:

**1. Backfill.** A one-time, idempotent SQL script (below) inserts the missing `hash`/`created_at` rows for `0001` and `0003`, computed directly from the real migration files — `sha256` of each `.sql` file's exact bytes, `created_at` = that file's own `when` timestamp from `meta/_journal.json`. This is the identical algorithm `drizzle-orm`'s own migrator uses, confirmed by reading the installed package source directly (`drizzle-orm@0.45.2`'s `pg-core/dialect.js` + top-level `migrator.js`), not assumed from memory. `0002` is guarded the same way (`WHERE NOT EXISTS (... created_at = X)`) rather than assumed absent, since its status was genuinely never confirmed either way — if a real row already exists there, this insert is a no-op.

**2. Standing default, not just this one fix:** for any future `ALTER TYPE ... ADD VALUE` migration, go straight to Neon's SQL Editor. `drizzle-kit migrate` is 2-for-2 failing on this exact statement type in this project's own history, in what looks like a genuine upstream interaction — ADR 0021 already ruled out lock contention via `pg_stat_activity` at the time. Trying the CLI first is no longer a reasonable default; it's a predictable delay before the fallback everyone already expects to need.

## What changed

- Backfill SQL run once against both the dev and prod Neon branches (ADR 0023) — not committed as a migration file itself, since it writes bookkeeping metadata, not schema.
- `README.md`'s "Apply the database schema" step — added a callout warning about the known hang, pointing straight at the SQL Editor for enum additions, so a new contributor doesn't lose time rediscovering this from scratch.

## Backfill SQL

```sql
-- One-time bookkeeping backfill. Idempotent — safe to run more than once,
-- and safe even if 0002 already has a row (see Decision, part 1).
-- Run against BOTH the dev and prod Neon branches.

CREATE SCHEMA IF NOT EXISTS "drizzle";
CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);

-- 0001_overjoyed_wild_pack — confirmed absent (ADR 0021 / Phase 5).
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
SELECT '2aa3b1770b259d101bc73bdc7580d23a08d028744974e9daee24e71415b521f5', 1784677308045
WHERE NOT EXISTS (
  SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE created_at = 1784677308045
);

-- 0002_spotty_elektra — status never confirmed (ADR 0022 / Phase 6). Guard
-- makes this a no-op if a real row already exists.
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
SELECT '8a686a2ebf4d70b29efcbc3ccf274f0b25c5101270add0d589bd7ac9007c1856', 1784789475708
WHERE NOT EXISTS (
  SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE created_at = 1784789475708
);

-- 0003_wide_silver_sable — confirmed absent (ADR 0024 / Go session).
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
SELECT '249f3fa44e9e4ea88e3a85954b86fc1b4e1b38099f949a043501a1b3d6a152a5', 1785044819736
WHERE NOT EXISTS (
  SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE created_at = 1785044819736
);

-- Verify — should show all 4 migrations (0000 was already correctly
-- recorded back at Phase 0), in order, with no duplicates.
SELECT id, hash, created_at, to_timestamp(created_at / 1000) AS applied_at
FROM "drizzle"."__drizzle_migrations"
ORDER BY created_at;
```

Worth an independent eyeball against the verification query's output before trusting it blind — same standard this project holds any hand-run SQL to.

## Verification

Hashes/timestamps computed against the real files in this repo, cross-checked against `drizzle-orm@0.45.2`'s own migrator source rather than assumed. Confirmed live on both Neon branches — dev and prod both show the query result in correct chronological order with no duplicates.

## Consequences

- No schema change, no new migration file — this only touches `drizzle`'s own bookkeeping table.
- Doesn't change anything about how migrations actually apply: `drizzle-orm`'s `migrate()` only uses the single most-recent `created_at` row as a watermark to decide what to (re-)run next, so this gap was never a correctness risk for future migrations — only a transparency/audit gap. Worth recording explicitly, since it clarifies this was never urgent, just untidy.
- Future enum additions go straight to the SQL Editor by default — documented in the README now, not just tribal knowledge carried in ADRs someone has to go find.
