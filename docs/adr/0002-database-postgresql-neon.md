# ADR 0002 — Database: PostgreSQL via Neon (Free Tier)

**Status:** Accepted  
**Date:** 2026-06-29  
**Phase:** 0 — Foundation

---

## Context

The project requires a relational database to store repos, dependencies, advisories, missions, and scoring data. It must be:

- Free at the scale required by the MVP (hard cap of 3 repos).
- Accessible from Vercel serverless functions without a persistent connection.
- Standard SQL so the schema is portable if the provider changes.

## Decision

Use **PostgreSQL hosted on Neon free tier** as the primary database.

- Neon provides serverless Postgres with connection pooling via PgBouncer.
- Free tier: 0.5 GB storage, 1 compute unit, sufficient for MVP (3 repos).
- Neon's HTTP driver (`@neondatabase/serverless`) works with Vercel Edge and serverless functions without maintaining a persistent TCP connection.
- If the project needs a fully offline mode, **SQLite** is used instead (local dev and CLI).

## ORM / Query layer

No ORM has been selected for Phase 0. The schema is defined in raw SQL (`packages/core/src/db/schema.sql`). The recommended query layer is **Drizzle ORM** — it is free, TypeScript-native, generates types from the schema, and works with Neon's HTTP driver. Drizzle adoption is a **Phase 1 decision point** and requires its own ADR before implementation.

Alternatives considered: Prisma (heavier runtime, less suited to edge), Kysely (good choice if Drizzle is rejected), raw `postgres` driver (lowest overhead, highest boilerplate).

## Alternatives considered

| Option            | Rejected because                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PlanetScale MySQL | MySQL is not Postgres; OSV JSONB queries would require different handling. PlanetScale's free tier was discontinued (2024).                                    |
| Supabase          | Free tier available, but adds Auth and Storage services that are out of scope; Neon is leaner.                                                                 |
| SQLite (primary)  | No managed hosting; not suitable for Vercel serverless without hacks (e.g. Turso/libsql adds a free-tier account dependency). Good for local dev and CLI only. |
| MongoDB Atlas     | Non-relational; relational joins (deps ↔ advisories ↔ missions) are cleaner in SQL.                                                                            |
| Redis             | Not a primary store; could be added for caching in a later phase.                                                                                              |

## Consequences

- All SQL DDL lives in `packages/core/src/db/schema.sql`. TypeScript types mirror it in `packages/core/src/db/types.ts`.
- Schema migrations must be versioned (numbered SQL files or a migration tool). Migration tooling is a Phase 1 decision point.
- The ingestion scripts must use Neon's serverless driver or a compatible pooler — a standard TCP `pg` connection will time out in a serverless context.
- When a lock file is absent, scores carry reduced confidence; this is represented in the schema via `score_confidence` and `confidence_flags`.

## Free-tier compliance

Neon: free, 0.5 GB storage, no credit card required for free tier (as of 2026-06-29, verified at neon.tech/pricing).
