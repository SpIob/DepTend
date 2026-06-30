# ADR 0005 — Migration Tooling: Drizzle Kit

**Status:** Accepted  
**Date:** 2026-06-29  
**Phase:** 0 — Foundation

---

## Context

The initial schema was applied directly via `psql` against Neon using `packages/core/src/db/schema.sql`. Before any Phase 1 code is written, a repeatable migration strategy must be in place. Every subsequent schema change must be versioned, auditable, and executable without manual SQL work.

Requirements:

- Free at all usage levels.
- TypeScript-native — types should be derivable from the schema, not maintained separately.
- Compatible with Neon's serverless driver and PgBouncer pooling.
- Manageable by one person without a dedicated migration server or CLI wrapper.

This decision was flagged as a Phase 1 gate in ADR 0002 and ADR 0004.

## Decision

Use **Drizzle Kit** as the migration tooling, with **Drizzle ORM** as the query layer.

- Drizzle Kit generates numbered SQL migration files from a TypeScript schema definition. The generated files are committed to the repo and applied explicitly — no hidden magic.
- The TypeScript schema in `packages/core/src/db/schema.ts` becomes the single source of truth. `packages/core/src/db/schema.sql` is retained as a reference artifact but is no longer the authoritative definition.
- Migrations are applied via `drizzle-kit migrate` against `DATABASE_URL_UNPOOLED` (the direct Neon connection string). The pooled connection is used by the application at runtime; the unpooled connection is used for DDL operations only.
- Drizzle ORM replaces raw `pg` queries in `/app` and `/packages/core`. All queries are written using Drizzle's query builder and are fully typed against the schema.

## Migration workflow

1. Edit the schema in `packages/core/src/db/schema.ts`.
2. Run `pnpm drizzle-kit generate` to produce a new numbered migration file in `packages/core/src/db/migrations/`.
3. Commit the migration file alongside the schema change in the same PR.
4. Run `pnpm drizzle-kit migrate` (using `DATABASE_URL_UNPOOLED`) to apply it to Neon.
5. Vercel deployment is unaffected — migrations are never run automatically on deploy.

## Alternatives considered

| Option                                | Notes                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw numbered SQL files + shell runner | Zero dependencies, full control. Rejected because TypeScript types must then be maintained separately from the SQL, violating the single-source-of-truth principle. |
| Prisma Migrate                        | Heavier runtime (`prisma/client` generated code); less suited to Vercel Edge and Neon's HTTP driver. Rejected in ADR 0002.                                          |
| Kysely migrations                     | Good TypeScript support, but Kysely is a query builder only — migration file generation requires additional tooling. More setup overhead for equivalent outcome.    |
| Flyway                                | JVM-based; adds a non-JavaScript runtime dependency to a Node.js-only project. Incompatible with the solo-developer, low-overhead constraint.                       |

## Consequences

- `packages/core/src/db/schema.ts` is created as the authoritative schema definition. It must stay in sync with all applied migrations.
- `packages/core/src/db/migrations/` is added to the repo. Migration files are committed and never edited after they are applied.
- `drizzle.config.ts` is added at the repo root, pointing at the schema file and migrations directory.
- `packages/core/src/db/types.ts` is removed or replaced — Drizzle infers TypeScript types directly from the schema, making a separate types file redundant.
- The `DATABASE_URL_UNPOOLED` environment variable is required locally and as a GitHub Actions secret for any workflow that runs migrations.
- The initial schema applied via `psql` is treated as migration `0000_initial`. Drizzle Kit's migration table (`__drizzle_migrations`) must be seeded to acknowledge it before the next `drizzle-kit migrate` run, to prevent re-application.

## Free-tier compliance

Drizzle ORM and Drizzle Kit: free, Apache 2.0 licensed.  
No additional accounts, services, or infrastructure required.
