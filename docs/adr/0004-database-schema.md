# ADR 0004 — Database Schema Design

**Status:** Accepted  
**Date:** 2026-06-29  
**Phase:** 0 — Foundation

---

## Context

The schema must store dependency, advisory, and scoring data in a way that is:

- Auditable: every score must be reproducible from stored inputs.
- Transparent: advisory sources must be attributable.
- Resilient to low-confidence data: lock files may be absent; CVSS scores may be missing.
- Extensible to new ecosystems without a full redesign.

## Decisions

### 1. All primary keys are UUIDs

Using `gen_random_uuid()` (pgcrypto). Auto-increment integers expose row count (information leakage) and create merge conflicts if data is ever replicated between environments. UUIDs have neither problem.

### 2. Advisories are global, dependencies are per-repo

`advisories` is a shared table across all repos. If 3 repos all depend on `lodash` and there is one `GHSA-p6mc-r…` advisory for lodash, there is exactly one row in `advisories` and three rows in `dependency_advisories` (one per repo's lodash dependency). This avoids duplicating large `raw_data` JSONB blobs.

### 3. Scoring inputs stored as JSONB on `mission_scores`

The transparency-first requirement means every displayed score must be reproducible without re-fetching external APIs. Storing `impact_inputs`, `effort_inputs`, and `ecosystem_value_inputs` as JSONB on `mission_scores` satisfies this at zero additional query cost. The shapes are typed in TypeScript (`ImpactInputs`, `EffortInputs`, `EcosystemValueInputs`).

### 4. `score_confidence` + `confidence_flags` are first-class columns

Low confidence (e.g. no lock file, missing CVSS) is **not** hidden — it is stored explicitly and surfaced in the UI. `confidence_notes` is `TEXT[]` (multiple notes possible per mission). `confidence_flags` is JSONB for programmatic checks. This satisfies the explainability standard in the project plan.

### 5. `ingestion_runs` is an append-only audit log

Rows in `ingestion_runs` are never updated or deleted. They record every execution with counts and error details. This supports debugging without paid observability tooling.

### 6. Soft-delete pattern for missions

Missions are not hard-deleted when dismissed. `status = 'dismissed'` with `dismissed_at` and `dismiss_reason` preserves history. Resolved missions stay in the table with `status = 'resolved'`. This supports future analytics and changelog generation.

### 7. `updated_at` managed by a trigger

All mutable tables have a `set_updated_at()` trigger so application code never forgets to update the timestamp.

## Schema not included (deliberately deferred)

- **Users table:** GitHub OAuth returns a username; we store it as `TEXT` (e.g. `submitted_by`, `claimed_by`) without a full user entity. A proper users table is deferred until Phase 5 when claiming missions requires persistent state.
- **Comments / discussion:** Out of scope for MVP.
- **Repo topics / tags:** Stored as `TEXT[]` on `repos`; a separate topics table is unnecessary at MVP scale.

## Migration strategy

Migration tooling is a **Phase 1 decision point** (see ADR 0002). Options: raw numbered SQL files + a simple runner script, Drizzle Kit migrations, or Flyway. The decision must be made before the first schema migration in Phase 1.

## Free-tier compliance

All schema decisions use standard PostgreSQL features available on Neon free tier. No extensions beyond `pgcrypto` (which Neon enables by default).
