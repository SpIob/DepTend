# ADR 0038; Lock File Parsing: Resolved Versions and Transitive Dependencies

**Status:** Proposed
**Date:** 2026-08-28

---

## Context

Since Phase 1, DepTend has parsed only manifest files (`package.json`, `pyproject.toml`, `requirements.txt`, `go.mod`) and explicitly deferred lock file parsing. This created several persistent limitations:

1. **`dependencies.resolved_version` always `null`**; The column exists in the schema but was never populated. The "current version" for bump inference was estimated from the manifest's version range floor (`semver.minVersion()` / `inferPep440Floor()`), not the actually-installed version.

2. **`is_transitive` always `false`**; Only direct dependencies from the manifest were ingested. Transitive dependencies (dependencies of dependencies) were never visible, so the impact scorer's transitive discount (ADR 0006) was inert.

3. **Confidence uniformly degraded**; Every mission carried `no_lock_file: true` in `confidence_flags`, capping confidence at `"medium"` (1 flag) or `"low"` (2+ flags with `breaking_change_signals_unavailable` also always set). This made confidence non-discriminating.

4. **Effort estimation inaccuracy**; `semver_bump` was computed from the manifest range's lower bound to the target, not from the actually-installed version to the target. For a dependency on `^1.2.0` with `1.2.5` actually installed, a fix to `1.3.0` was scored as "minor" (floor `1.2.0` → `1.3.0`) instead of "patch" (`1.2.5` → `1.3.0`).

Lock file parsing was deferred because:

- It requires ecosystem-specific parsers (npm, pnpm, yarn, Poetry, Pipenv, PDM, Go)
- It adds I/O (fetching/reading additional files) to the ingestion pipeline
- The dependency graph can be large, adding DB rows for transitive deps

## Decision 1; Parse lock files for all three ecosystems

**Scope for this ADR (MVP):**

- **npm**: `package-lock.json` (npm v7+ format), `yarn.lock` (v1 Classic + v2+ Berry via `@yarnpkg/lockfile`)
- **PyPI**: `poetry.lock`, `Pipfile.lock` (deferred to follow-up ADR)
- **Go**: `go.sum` (deferred to follow-up ADR)

Start with `package-lock.json` and `yarn.lock` as they cover the vast majority of npm/Yarn projects. pnpm (`pnpm-lock.yaml`) and Python/Go lock files are explicitly deferred.

**Parser architecture:**

- Pure, no-I/O functions in `packages/core/src/ingestor/*-lock-parse.ts`
- Shared merge logic in `lock-parse.ts`
- Ingestors (`npm.ts`, `local-npm.ts`) fetch/read lock file content and pass to parser
- Graceful degradation: if lock file parsing fails, fall back to manifest-only (current behavior) with a warning

## Decision 2; Add `transitive` to `dep_type` enum

**Schema change:** `ALTER TYPE dep_type ADD VALUE 'transitive'`

Transitive dependencies (found in lock file but not in manifest) are written with `dep_type = 'transitive'` and `is_transitive = true`. This:

- Requires a migration (applied to both dev/prod Neon branches per ADR 0023)
- Makes transitive deps queryable and filterable
- Avoids overloading `"production"` for semantically different things

Manifest deps keep their declared `dep_type` (production/development/peer/optional) with `is_transitive = false`.

## Decision 3; Scoring version bump to `1.1.0`

**Behavioral changes:**

| Aspect                         | v1.0.0                                       | v1.1.0                                        |
| ------------------------------ | -------------------------------------------- | --------------------------------------------- |
| `semver_bump` current version  | Manifest range floor (`semver.minVersion()`) | Lock file `resolved_version` (when available) |
| `is_transitive` input          | Always `false`                               | `true` for transitive deps                    |
| `no_lock_file` confidence flag | Always set                                   | Only when `resolved_version` is null          |
| `dep_type` values              | production/development/peer/optional         | + `transitive`                                |

**Impact on existing missions:**

- Missions re-scored on next ingestion run will use v1.1.0
- `scoring_version` column tracks which version produced each score
- No migration of historical scores; they retain their original version

**Confidence improvement:**

- Deps with lock file data lose `no_lock_file` flag → many missions drop from 2 flags → 1 flag → confidence `"medium"` (first time since Phase 2)
- Combined with ADR 0029/0032, some missions can reach `"high"` (0 flags)

## Decision 4; Transitive dependency handling

- **Written to DB**: Yes, as `dep_type = 'transitive'` rows
- **Mission generation**: Yes, `vulnerability_fix` missions created for affected transitive deps
- **UI**: No special treatment; they appear in mission boards like any other dep
- **Limit**: Cap at 500 transitive deps per repo to bound ingestion cost (configurable via env)

## Decision 5; Yarn v2+ (Berry) support via `@yarnpkg/lockfile`

The `@yarnpkg/lockfile` package parses both:

- Yarn v1 Classic: `yarn.lock` text format
- Yarn v2+ (Berry): `yarn.lock` + `.yarn/cache` metadata

This single dependency covers both formats. It's a well-maintained, zero-runtime-dependency package from the Yarn team.

## Decision 6; Ingestion pipeline integration

**HTTP ingestor (`npm.ts`):**

1. Fetch `package.json` (existing)
2. Try `package-lock.json` → if 404, try `yarn.lock` → use first found
3. Pass both manifest + lock content to `parsePackageJsonContent()`

**Local ingestor (`local-npm.ts`):**

1. Read `package.json` from disk (existing)
2. Read `package-lock.json` or `yarn.lock` from disk
3. Pass both to parser

**Writer (`writer.ts`):**

- `upsertDependencies()` now receives `dep.resolved_version` and `dep.dep_type` (including `'transitive'`)
- Writes both to DB; no other changes needed

**Scorer (`mission-scorer.ts`):**

- `buildImpactInputs()`: reads `ctx.dependency.is_transitive`
- `buildEffortInputs()`: uses `ctx.dependency.resolvedVersion` as current version when present
- `deriveConfidenceFlags()`: sets `no_lock_file` only when `resolvedVersion === null`
- `SCORING_VERSION = "1.1.0"`

## Decision 7; Test fixtures from real projects

Collect real lock files from popular projects for unit/integration tests:

- npm: `express`, `lodash`, `react`, `typescript`, `vite`, `next.js`, `webpack`
- Yarn: `yarn`, `babel`, `jest`, `eslint`

---

## Alternatives Considered

| Decision                    | Alternative                           | Why Not                                                                |
| --------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| Transitive dep type         | Reuse `"production"`                  | Loses semantic distinction; can't filter/query transitive vs direct    |
| Yarn v2+ parser             | Custom minimal parser                 | `@yarnpkg/lockfile` is official, maintained, handles both v1/v2        |
| All ecosystems at once      | Parse PyPI/Go lock files too          | Scope creep; npm/Yarn cover majority of projects; defer to follow-ups  |
| No scoring version bump     | Keep v1.0.0, silently change behavior | Violates transparency — scores would change meaning without visibility |
| Transitive deps not written | Only use for scoring, don't persist   | Loses auditability; can't show "this mission is for a transitive dep"  |

---

## Consequences

**Positive:**

- `resolved_version` populated → accurate `semver_bump` → better effort estimation
- `is_transitive` real → impact scorer's transitive discount activates
- `no_lock_file` flag conditional → confidence becomes discriminating (medium/high achievable)
- Transitive vulns surfaced as missions → more complete security picture

**Negative:**

- Migration required (enum change); must apply to both Neon branches
- More HTTP requests per repo (lock file fetch); ~1-2 extra per ingestion
- More DB rows (transitive deps); capped at 500/repo
- Scoring v1.1.0 changes mission ordering; board may shift on re-ingestion
- New dependency: `@yarnpkg/lockfile` (MIT, zero runtime deps, from Yarn team)

**Neutral:**

- PyPI/Go lock files still deferred; no change for those ecosystems
- CLI gets same improvements via shared `build-rows.ts`

---

## Implementation Plan

1. **ADR + Migration**; Create ADR, generate migration `0007_add_transitive_dep_type.sql`
2. **Core Types**; Update `interface.ts` with `resolved_version`, `is_transitive`, lock metadata
3. **Parsers**; Create `npm-lock-parse.ts`, `yarn-lock-parse.ts`, `lock-parse.ts`
4. **Ingestors**; Update `npm.ts`, `local-npm.ts` to fetch/read lock files
5. **Parser Integration**; Update `npm-parse.ts` to accept lock content, merge
6. **Writer**; `writer.ts` writes `resolved_version` (already has column)
7. **Scorer**; `mission-scorer.ts` v1.1.0 logic, confidence changes
8. **CLI**; `build-rows.ts` passes `resolved_version`
9. **Tests**; Unit tests for parsers, integration tests for pipeline
10. **Verification**; Full gate, manual ingestion on test repos, production deploy

---

## Free-tier Compliance

- `@yarnpkg/lockfile`: MIT license, zero runtime dependencies, maintained by Yarn team
- No new services, no paid tiers, no schema changes beyond the enum addition
- Neon free tier handles additional transitive dependency rows (capped at 500/repo × 150 repos = 75k rows max)

---

## Verification Criteria

- [ ] Migration applies cleanly to dev and prod Neon branches
- [ ] All existing tests pass + new parser tests pass
- [ ] Manual ingestion on 5 test repos populates `resolved_version` and `dep_type: transitive`
- [ ] Confidence distribution shifts: some missions show `"medium"` (was all `"low"`)
- [ ] Scoring v1.1.0 produces reasonable `semver_bump` values vs v1.0.0
- [ ] Full verification gate (typecheck, test, build, lint, format) passes

---

_End of document._
