# ADR 0011 — schema.ts as the Single Row-Type Source; db/types.ts Removed

**Status:** Accepted
**Date:** 2026-07-09
**Phase:** 3 (first decision point, per Phase2_Status.md "Phase 3 Entry State")

---

## Context

`packages/core/src/db/types.ts` and `packages/core/src/db/schema.ts` have been two independently hand-maintained representations of the same rows since Phase 0 — `schema.ts` a Drizzle ORM schema (camelCase, `$inferSelect`/`$inferInsert`), `types.ts` a hand-written parallel set of interfaces (snake_case, matching the raw SQL column names). `schema.ts` has been the documented DB source of truth since Phase 0 (Deviation #5), but `types.ts` was never retired, and the two drifted: `schema.ts`'s `cvssScore` (a Drizzle `numeric` column, inferred as `string | null` without an explicit mode) vs. `types.ts`'s hand-written `cvss_score: number | null`. The gap was bridged, not resolved — `scorer/writer.ts` carried three conversion functions (`toCoreRepo`, `toCoreDependency`, `toCoreAdvisory`) that translated a Drizzle row into a `db/types.ts` shape at the one read boundary where both systems met.

This is worth resolving now rather than carrying it into `/app`, for two reasons specific to this project:

1. **It already drifted once, silently, with no compiler error.** Nothing caught the `cvssScore` string/number mismatch until it was noticed by inspection. A solo project with no code review has no second pair of eyes to catch the next drift; the type system is the only backstop, and two hand-synced sources of truth don't give it anything to check against.
2. **`/app` is the next consumer, and would have had to pick one shape anyway.** Deferring this into Phase 3 would mean either building `/app` against `types.ts` (and adding a fourth conversion function, this time at the API-route boundary) or against `schema.ts` (and accepting its two real gaps — see below) without ever having named the trade-off.

`schema.ts`'s two real gaps, both mechanical to close:

- **JSONB columns had no `$type<>()`,** so `affected_versions`, `impact_inputs`, `ecosystem_value_inputs`, `effort_inputs`, and `confidence_flags` all inferred as `unknown` on select — `types.ts`'s hand-written `ImpactInputs`/`EffortInputs`/`EcosystemValueInputs`/`ConfidenceFlags`/`OsvVersionRange` interfaces were the only place these shapes were captured at all.
- **Numeric columns had no `mode: "number"`,** so `cvss_score`, `impact_score`, `ecosystem_value_score`, and `composite_score` all inferred as `string | null` / `string` — every call site that wrote one of these (`osv.ts`, `scorer/writer.ts`) had a manual `String(x)` or `.toFixed(1)` to satisfy the insert type, and every call site that read one had a manual `Number(x)` to undo it.

Neither gap is a Drizzle limitation — both have first-class, documented solutions (`.$type<T>()` on a jsonb column builder; `{ mode: "number" }` on a numeric column builder), confirmed against the installed `drizzle-orm@0.45.2` type definitions before this ADR was written.

## Decision

**`schema.ts` is the sole row-type source. `db/types.ts` is deleted, not deprecated.** Two new files take over what `db/types.ts` held that wasn't a row type:

- **`db/json-types.ts`** — the five JSONB payload interfaces (`OsvVersionRange`, `ImpactInputs`, `EcosystemValueInputs`, `EffortInputs`, `ConfidenceFlags`). These were never actually part of the divergence problem — they're opaque-to-Postgres blobs with no `$inferSelect` equivalent, so they stay hand-written regardless of which system "wins." Moved unchanged, and wired into `schema.ts`'s jsonb columns via `.$type<T>()` so a `select()` returns the real shape instead of `unknown`.
- **`db/query-types.ts`** — derived join-result types with no single-table equivalent (`MissionWithScore`, `RepoWithIngestionStatus`), built on top of `schema.ts`'s inferred types rather than duplicating their fields. `MissionWithScore` is what Phase2_Status.md flagged as "already defined ... ready for `/app` to consume" — it's re-defined here on the new base rather than lost.

**Enum unions are now derived from the `pgEnum` objects** (`(typeof severityEnum.enumValues)[number]`, etc.) instead of hand-declared a second time — this closes a smaller, lower-risk instance of the same duplication pattern for `Ecosystem`, `Severity`, `DepType`, `EffortLabel`, `ScoreConfidence`, `MissionType`, `MissionStatus`, `IngestionStatus`, `AdvisorySource`.

**`rawData` (the verbatim OSV snapshot) deliberately keeps no `$type<>()`.** It's genuinely unstructured by design (ADR 0010: "the actual full OSV record verbatim"), and a concrete interface isn't structurally assignable to an index-signature type like `Record<string, unknown>` without an escape hatch at the one write site — narrowing it would trade a real gap for a cosmetic one.

**`scorer/writer.ts`'s three conversion functions are deleted.** `generateMissionsForRepo` now passes Drizzle's `select()` rows straight into `MissionScoringContext`, which is retyped against `schema.ts`'s `Dependency`/`Advisory`/`Repo`.

## Consequences

Mechanical, camelCase-for-snake_case field renames, no logic changes, in:

- `scorer/mission-scorer.ts` — `MissionScoringContext` retyped; ~9 field accesses renamed (`cvss_score`→`cvssScore`, `dep_type`→`depType`, `published_at`→`publishedAt`, `fixed_version`→`fixedVersion`, `latest_version`→`latestVersion`, `version_spec`→`versionSpec`, `resolved_version`→`resolvedVersion`, `open_issues_count`→`openIssuesCount`).
- `scorer/mission-copy.ts` — same class of rename (`package_name`, `version_spec`, `dep_type`, `cvss_score`, `fixed_version`, `osv_id`, `source`); this file doesn't import `db/types.ts` directly but consumes `MissionScoringContext`, so it was still in scope.
- `scorer/writer.ts` — bridge functions removed; `upsertMissionScore` drops `.toFixed(1)` on the three score columns (`mode: "number"` handles precision at the DB level).
- `ingestor/osv.ts` — `cvssScore: cvssScore !== null ? String(cvssScore) : null` simplifies to `cvssScore` (already `number | null`).
- Import-path-only changes (no field renames — these consume `ImpactInputs`/`EffortInputs`/`EcosystemValueInputs`/enum types, which are unchanged in shape): `scorer/impact.ts`, `scorer/effort.ts`, `scorer/ecosystem-value.ts`, `scorer/ranking.ts`, `scorer/interface.ts`, `ingestor/interface.ts`.
- `index.ts` — barrel changes from `export * from "./db/types.js"` to `export type * from "./db/schema.js"` (type-only, so `schema.ts`'s `pgTable`/`pgEnum` runtime objects stay internal, matching this file's existing "avoid accidental coupling" rule) plus `export * from "./db/json-types.js"` and `./db/query-types.js`.
- Test fixtures in `scorer/mission-scorer.test.ts` and `scorer/mission-copy.test.ts` — `makeDependency`/`makeAdvisory`/`makeRepo` helpers and their `overrides` converted to camelCase. Assertions on `ImpactInputs`/`EffortInputs`/`EcosystemValueInputs`/`ConfidenceFlags` output are unchanged (still snake_case — those interfaces didn't move).
- Import-path fixes in `scorer/impact.test.ts`, `scorer/effort.test.ts`, `scorer/ecosystem-value.test.ts`, `scorer/ranking.test.ts` — these still pointed at `db/types.js` and were missed by `tsc --noEmit` (test files are excluded from `packages/core/tsconfig.json`) and by `vitest run` (esbuild elides `import type` statements at transpile time rather than resolving them, so a deleted target module never surfaces as a runtime error). **`eslint --max-warnings 0` was the only one of the four standard checks that caught this** — typed linting resolves the import for real and surfaces it as `no-unsafe-argument` against an `error`-typed value. Worth remembering: a clean `tsc --noEmit` + green `vitest run` is not sufficient evidence a test file's imports are valid when tests are typecheck-excluded.
- One-value fixture fixes for the same reason (mock now needs a `number`, not a `string`): `ingestor/osv.test.ts` (`cvssScore` assertion), `ingestor/writer.test.ts` and `scorer/writer.test.ts` (mock row literals).
- `docs/data-model/README.md` — stale `schema.sql` reference corrected to `schema.ts`, per the Phase 2 status doc's outstanding housekeeping item #4 (`db/types.ts`'s own stale header comment is moot — the file is deleted).

**Verified against the real toolchain, not just read for correctness:** `pnpm install`, then `tsc --noEmit` (packages/core), `vitest run` (197/197 passing, unchanged from pre-refactor baseline), `tsc --project tsconfig.json` (clean build), `eslint . --max-warnings 0` (0 errors after the four import-path fixes above), `prettier --check` (clean after `--write` on 3 files). No schema migration — this is a TypeScript-level change only; no `DDL`, no `drizzle-kit generate` needed.

**No `NewAdvisory`/`NewMissionScore` insert-site changes were needed beyond the two already listed** (`osv.ts`'s `cvssScore`, `writer.ts`'s three `.toFixed(1)` calls) — every other JSONB write site (`affectedVersions`, `rawData`, `impactInputs`, `ecosystemValueInputs`, `effortInputs`, `confidenceFlags`) was already passing a value of the exact shape now declared via `$type<>()`, confirmed by a clean `tsc --noEmit` with zero additional errors at those sites.

## Free-tier compliance

No new dependency, no new service. TypeScript-level change only.
