# ADR 0007 — Mission Score Wiring: Input Mapping, Confidence Derivation, Ranking

**Status:** Accepted
**Date:** 2026-07-05
**Phase:** 2 — Scoring Engine

---

## Context

ADR 0006 defined the three scoring formulas and the composite/tie-break rules, and `packages/core/src/scorer/{impact,effort,ecosystem-value}.ts` implement them against clean `*Inputs` types. Wiring them into the pipeline means mapping real `Dependency` / `Advisory` / `Repo` rows (`packages/core/src/db/types.ts`) onto those `*Inputs` shapes, and deriving `ConfidenceFlags` from what's actually missing in the data — not from assumption.

Doing that mapping surfaced several gaps that ADR 0006 didn't need to address because it only covered the formulas, not where their inputs come from.

## Decisions

### 1. Mission scope for Phase 2: `vulnerability_fix` only

`Mission.mission_type` supports `vulnerability_fix | dep_update | maintenance | license_issue`, and `Mission.advisory_id` / `dependency_id` are both nullable — the schema was deliberately built to support all four. But `ImpactInputs` requires `cvss_score` and `severity`, which only exist on `Advisory` rows. There's no non-advisory-based signal ingested yet (Phase 1) that could stand in for "impact" on a `dep_update` or `maintenance` mission without fabricating one.

**Decision:** Phase 2 generates `vulnerability_fix` missions only — one candidate per `dependency_advisories` row where `is_affected = true`. `dep_update` / `maintenance` / `license_issue` mission generation is deferred to a later phase, once there's a real basis for scoring their impact. This isn't a schema change — those enum values and nullable columns stay as-is for when that phase arrives.

### 2. `is_transitive` is always `false` in Phase 1/2

`NpmIngestor` (Phase 1) only parses the four direct-dependency sections of `package.json` — it does not walk the dependency graph. There is currently no code path that could produce a transitive dependency row at all. `ImpactInputs.is_transitive` is therefore always `false` for now; the transitivity discount in `ImpactScorer` is correct as written but inert until a later phase adds transitive resolution.

### 3. `no_lock_file` is derived from `dependency.resolved_version === null`, not from `lock_file_present`

`NpmIngestor.detectLockFile()` computes `lock_file_present` (`ingestor/interface.ts`), but that value is only logged in `scripts/ingest.js` — it's never written to the database. More importantly, `IngestionWriter` hard-codes `resolvedVersion: null` regardless of `lock_file_present`, because lock file _parsing_ (not just detection) is what's deferred. So even a repo with a lock file present gets no resolved version today.

**Decision:** the `no_lock_file` confidence flag is keyed off the real, persisted signal — `dependency.resolved_version === null` — rather than the unpersisted, and currently less meaningful, `lock_file_present` flag. This is accurate today and will automatically become conditional (rather than universally true) once lock file parsing actually lands and starts populating `resolved_version`, with no change needed here.

### 4. `semver_bump` inference: new dependency, and a documented limitation

Computing `EffortInputs.semver_bump` needs two versions to diff: what's currently declared (`dependency.version_spec`, e.g. `"^1.2.3"`) and the target (`advisory.fixed_version`, falling back to `dependency.latest_version` when the advisory has no fixed version yet). Since `resolved_version` is always null (see #3), the "current" side can only ever be an estimate — the minimum version satisfying the declared range.

**New dependency: `semver` (^7.8.5, zero runtime dependencies, ISC license, maintained by the npm CLI team).** Hand-rolling range parsing (caret/tilde semantics, `x`-ranges, hyphen ranges, prerelease rules) is exactly the kind of thing that's easy to get subtly wrong, and this is a well-maintained, zero-dependency, free package built for precisely this. `@types/semver` (^7.7.1) is added as a dev dependency alongside it.

Tested behavior that shaped the implementation (`semver.validRange`, `semver.minVersion`, `semver.coerce`, `semver.diff`):

- `semver.minVersion` **throws** on non-range strings that npm nonetheless allows in `package.json` (`"latest"`, `"workspace:*"`, `"file:../foo"`, git URLs) — the implementation gates on `semver.validRange` first (which returns `null` for these, without throwing) and wraps `minVersion` in `try/catch` as defense in depth.
- A wildcard range (`"*"`, or an empty string, which `validRange` also normalizes to `"*"`) carries no real version information. Treating it as `0.0.0` — which is what `minVersion` would literally return — would fabricate a "major bump" signal for essentially any target version. **Decision:** wildcard ranges resolve to `semver_bump: "unknown"`, not to a computed diff against `0.0.0`. This mirrors the "unknown severity gets the floor, not a middle value" principle from ADR 0006 — absence of information should never be dressed up as a specific, confident answer.
- `semver.coerce` fails gracefully (returns `null`, never throws) on the target side, which covers non-semver `fixed_version` values without extra guarding.

This inference is an estimate, not a confirmed fact, for the same reason `no_lock_file` exists — it's covered by that same flag rather than a new one, since the root cause (no resolved version) is identical.

### 5. `has_migration_guide` and `breaking_change_signals`: stubbed, not fabricated

No ingestion step exists yet that reads changelogs, release notes, or migration guides. Consistent with the `downstream_dependents` decision in ADR 0006: these are **not** inferred from proxies (e.g., guessing `has_migration_guide` from whether a `MIGRATING.md`-style file exists would be a real ingestion feature, not a scoring concern, and is out of scope here).

**Decision:** `has_migration_guide` defaults to `false` and `breaking_change_signals` defaults to `[]` for every mission in Phase 2. A new confidence flag, `breaking_change_signals_unavailable`, is added to `ConfidenceFlags` (JSONB shape change only, no migration) so this is visible rather than silently assumed. Sourcing this data is a backlog item for a later phase.

**Consequence worth flagging directly:** with both `downstream_dependents_unavailable` and `breaking_change_signals_unavailable` unconditionally `true` right now, every mission's flag count starts at 2 before any other gap is even considered — meaning **every mission will show `confidence: "low"` in Phase 2**, regardless of how good its CVSS/severity/version data actually is. This is an honest reflection of current data maturity, not a bug, and it's self-correcting: once either data source lands in a later phase, confidence rises automatically with no scoring-layer code change. But it does mean "confidence" has no discriminating power between missions until then — worth knowing before it shows up looking uniform on a future dashboard.

### 6. Confidence derivation and notes

Per ADR 0006: 0 flags → `high`, 1 flag → `medium`, 2+ flags → `low`, computed purely from the flag count. Each flag also produces one plain-language sentence in `confidence_notes` (e.g. _"No lock file was parsed for this dependency, so the currently-installed version is estimated from its declared range rather than confirmed."_) — this is what satisfies the explainability standard's "communicated visibly, not hidden" requirement; the flags alone are structured data, not something a user reads directly.

### 7. Tie-break ranking, implemented

ADR 0006 specified the rule; `rankMissions()` implements it: sort by `composite_score` descending, and where two scores are within **0.5** of each other, break the tie by `effort_label` ascending (`trivial < low < medium < high`), then `created_at` ascending. Noted as an implementation detail: epsilon-based "tied" comparisons aren't strictly transitive (A≈B and B≈C doesn't guarantee A≈C), which can occasionally make comparator-based sorts behave oddly across long chains of near-equal scores. Given the 3-repo MVP cap keeps mission lists small, this isn't worth the extra complexity of clustering ties before sorting — flagged here in case that assumption stops holding after the repo cap is revisited (Section on MVP repo cap, Project Instructions).

## Consequence for the future DB-writer step

`packages/core/src/db/types.ts`'s `Advisory.cvss_score` is typed as `number | null`, but the underlying Drizzle column (`schema.ts`) is `numeric("cvss_score", ...)` with no `{ mode: "number" }` set — Drizzle's default inferred type for `numeric` columns is `string`, not `number`. The functions in this ADR consume the `Advisory`/`Dependency`/`Repo` interfaces from `db/types.ts` directly and never touch Drizzle, so this doesn't affect them. But whoever writes the next piece — the actual DB read that loads rows via Drizzle and passes them into `buildImpactInputs` — needs to explicitly convert `cvssScore` from `string` to `number` first, or it'll silently become `NaN` partway through scoring instead of erroring loudly. Flagging this now so it isn't rediscovered the hard way later.

## What this ADR does not cover

- The actual database read (querying `dependency_advisories` joined to `dependencies`, `advisories`, `repos`) and the transactional upsert into `missions` / `mission_scores` — this is the next piece, not yet started.
- Mission `title` / `description` / `action_hint` text generation — these are `NOT NULL` on `missions`, so the DB-writer step will need a decision on templated copy generation. Not designed here.
- Hooking any of this into `scripts/ingest.js`.

## Free-tier compliance

`semver` is MIT/ISC-licensed and free with no usage tier. No new services, no schema migration.
