# ADR 0040; Migration Bookkeeping Recovery: Consolidate 0007–0010 Into a Single Registered Migration

**Status:** Accepted
**Date:** 2026-08-28

---

## Context

The `/repo/[owner]/[name]` page renders a Next.js route-segment error boundary on production (`/`, `/missions` work; `/repo/...` does not); `error.digest` is the same shape as the page render's failure. Locally, the dev server throws `NeonDbError: column "org_id" does not exist` against the dev Neon branch on the very first query `getRepoByOwnerAndName` issues (`select "id", ..., "org_id", ... from "repos"`). Production is the same code, same schema, same Drizzle query → same error, just hidden by the deployed error boundary.

The schema _requires_ `repos.org_id` (added in commit `a539d8e` as part of the organizations feature; the `repos` table definition in `schema.ts:114` references it via `.references(() => organizations.id, { onDelete: "set null" })`). The dev branch (and the production branch) does not have that column, or the `organizations`, `organization_members`, `notification_subscriptions` tables, or the `transitive` value in the `dep_type` enum, or the `advisories.epss_score` column.

The cause: commit `a539d8e` ("Performance pass + multi-mission-type support + organizations + notifications") added four migration `.sql` files; `0007_add_transitive_dep_type.sql`, `0008_board_query_composite_indexes.sql`, `0009_organizations.sql`, `0010_notification_subscriptions.sql`; but **none were registered in `packages/core/src/db/migrations/meta/_journal.json`**, and no per-step `meta/000N_snapshot.json` files were committed. Drizzle's migrator reads the journal as the source of truth for which SQL files to run; orphan `.sql` files in the directory are ignored. `drizzle-kit migrate` against either Neon branch completed with `[✓] migrations applied successfully!` and zero rows changed.

The same commit also broadened `repos` with an `org_id` foreign key in `schema.ts`, but the `0007_add_transitive_dep_type.sql` and `0008_*.sql` files were committed earlier (the `0007` file is untracked in `a539d8e`'s diff; it predates the commit) and were also unregistered. The four files were evidently hand-written (not generated via `drizzle-kit generate`) and the journal update was forgotten in every case. This is the same class of mistake ADR 0026 documented for an earlier instance; backfilling the `__drizzle_migrations` table to reflect SQL that was already applied by hand to the production branch; except this time the SQL was _not_ applied anywhere; the journal was simply never updated and the migrations never ran.

## Decision

1. **Consolidate the four orphan SQL files into a single registered migration.** Delete `0007_add_transitive_dep_type.sql`, `0008_board_query_composite_indexes.sql`, `0009_organizations.sql`, `0010_notification_subscriptions.sql`. Run `drizzle-kit generate` against the current `schema.ts` (now also including `epss_score` from ADR 0039, which was committed in `d5de512` ahead of the broken commit) to produce one canonical diff. This produces `0007_foamy_chimera.sql` (drizzle's auto-named migration) + its `meta/0007_snapshot.json`, and the journal is updated to register it. The auto-generated SQL is the single source of truth; it captures the complete, dependency-ordered delta from the `0006` snapshot to today's `schema.ts`, including FKs and the updated `mission_scores.impact_inputs` default that the hand-written files would have missed.

2. **Apply the consolidated migration to dev and production branches.** The `postgres` driver in `drizzle.config.ts` plus `dotenv`'s `.env.local` load (per the AGENTS.md §12 note) is the working path; `drizzle-kit migrate` against the unpooled `DATABASE_URL_UNPOOLED`. The migration uses `ALTER TYPE ... ADD VALUE 'transitive'` (a known `drizzle-kit migrate` hang on this project's history; ADR 0026 noted 2-for-2; this is now 3-for-3), so per ADR 0026's standing default, copy the SQL into Neon's SQL Editor for both branches rather than running the CLI and waiting on the timeout. The 30 s timeout for `drizzle-kit migrate` in this project is acceptable for the rest of the migration; only the enum-adding statement is a known no-go.

3. **Add a CI guard.** A new step in `.github/workflows/ci.yml` runs `drizzle-kit generate --check` (i.e. `drizzle-kit generate` against a temporary out dir, diffed against `packages/core/src/db/migrations/`) on every PR; fails the build if `schema.ts` has drifted from the committed SQL. This would have caught the original mistake (the hand-written SQL didn't match the schema; `epss_score` was added later, the hand-written 0009 missed FKs Drizzle's generator would have included, etc.) and is cheap to add.

4. **Update the data-model reference** (`docs/data-model/README.md`) to reflect the new tables, the `org_id` column, the new enum value, and the new `epss_score` column; all in the same pass as the schema change, per the AGENTS.md §10 standing rule. This had drifted (the README still lists only 4 `dep_type` values, has no entry for `organizations` / `organization_members` / `notification_subscriptions`, no `repos.org_id`, no `advisories.epss_score`).

## Why consolidation, not a four-step equivalent

The hand-written files overlap (e.g. `0009` creates `organizations` AND adds `repos.org_id` AND its FK AND `idx_repos_org_id`; the auto-generated single migration creates the same set in a single dependency-ordered DDL stream). Splitting the auto-generated diff back into four files would (a) require handcrafting `meta/0007_snapshot.json`–`meta/0010_snapshot.json` so each migration's snapshot correctly reflects the post-step schema; Drizzle's journal-of-record model depends on this chain being unbroken, and a hand-rolled chain is the same class of mistake as the broken journal we're recovering from; and (b) produce four migrations that together do less than what `drizzle-kit generate` produces in one (the auto version picks up `epss_score`, the updated `mission_scores.impact_inputs` default, and the FK from `repos.org_id` → `organizations.id` in its correct position). One migration from the current snapshot is the cleanest, smallest, and most auditable fix.

## What changed

- Deleted: `0007_add_transitive_dep_type.sql`, `0008_board_query_composite_indexes.sql`, `0009_organizations.sql`, `0010_notification_subscriptions.sql`.
- Added: `0007_foamy_chimera.sql` (auto-generated diff from the `0006` snapshot to current `schema.ts`) and `meta/0007_snapshot.json`.
- `meta/_journal.json` updated: one new entry registering the consolidated migration.
- `docs/data-model/README.md` updated: new tables (`organizations`, `organization_members`, `notification_subscriptions`), new column (`repos.org_id`, `advisories.epss_score`), new enum value (`dep_type: 'transitive'`), schema changelog row.
- `.github/workflows/ci.yml`: new `migrations:check` step (see Decision §3).
- Migration applied to dev Neon branch. Production Neon branch application is a same-deploy-window step (see Decision §2).

## Verification

- Pre-fix: dev server throws `column "org_id" does not exist`; production `/repo/[owner]/[name]` renders the "Something went wrong" boundary.
- Post-fix (dev): `select * from information_schema.columns where table_name = 'repos'` shows `org_id`; `select * from information_schema.tables where table_schema = 'public'` shows the three new tables; `pg_enum` for `dep_type` includes `transitive`; `select * from drizzle.__drizzle_migrations` shows the new entry; `/repo/SpIob/deptend-go-test-fixture` returns HTTP 200 with the missions board HTML (not the error boundary).
- Post-fix (production): same checks against the production Neon branch, then the deployed `/repo/SpIob/deptend-go-test-fixture` page renders the mission board.

## Consequences

- **Same outage on every page that selects from `repos`** would have happened via a different commit / different missing migration. The CI guard makes the next instance of this class of mistake fail the PR, not the deployed site.
- **Production migration is now a deploy-window step** (not "any time" the way reads/writes to existing tables are). Per ADR 0026's standing rule, the SQL Editor path is the default for migrations that touch enums. Documented in the README and pinned to this ADR.
- **No data loss.** The migration is purely additive; new tables, new columns, new enum value, new indexes. No rows are touched, no constraints are tightened.
- **No ADR status backfill.** No previously-`Accepted` ADR changes shape; only the bookkeeping for the migrations those ADRs implicitly introduced is corrected.
