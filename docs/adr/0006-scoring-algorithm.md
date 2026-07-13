# ADR 0006 — Scoring Algorithm: Impact, Effort, Ecosystem Value

**Status:** Accepted
**Date:** 2026-07-03
**Phase:** 2 — Scoring Engine

---

## Context

`packages/core/src/scorer/interface.ts` already defines the contracts (`ImpactScorer`, `EffortScorer`, `EcosystemValueScorer`, `CompositeScoreResult`) and the composite weighting (`composite = impact * 0.60 + ecosystem_value * 0.40`, with `effort_label` as a categorical tie-breaker). What has not yet been decided is _how_ each scorer turns its raw inputs into a number, and how confidence is computed and surfaced. Per the transparency-first constraint, every score must ship with its inputs, its weights, and a visible confidence signal — nothing here can be a black box.

Note: this ADR was originally going to be numbered 0005, per a stale comment in `scorer/interface.ts`. `0005` is already used by `0005-migration-tooling.md`. This is `0006`; the comment in `interface.ts` is corrected alongside this ADR.

Inputs available, per `packages/core/src/db/types.ts`:

- `ImpactInputs`: `cvss_score`, `severity`, `is_transitive`, `dep_type`, `days_since_advisory`
- `EffortInputs`: `semver_bump`, `has_migration_guide`, `breaking_change_signals`
- `EcosystemValueInputs`: `repo_stars`, `open_issues_count`, `downstream_dependents`

`repo_stars` and `open_issues_count` are already populated by the Phase 1 GitHub metadata fetch in `scripts/ingest.js`. `downstream_dependents` is not populated by anything yet — see the dedicated section below.

## Decision

Adopt the following as **scoring_version "1.0.0"**. These are initial, clearly-documented weights, not derived from data. They are meant to be validated and tuned against the Phase 2 exit criterion ("missions ranked correctly against a set of known test repos") — expect this ADR to gain a superseding v1.1 once real ranking behavior is checked against test repos.

### Impact score (0.0–10.0)

Base score:

- If `cvss_score` is present, use it directly (CVSS is already 0–10).
- Otherwise fall back to a severity midpoint: `critical → 9.0`, `high → 7.0`, `medium → 5.0`, `low → 2.5`, `unknown → 1.0`. `unknown` gets the conservative floor, not a middle value — we should never imply confidence we don't have.

Modifiers, applied multiplicatively to the base and clamped to `[0, 10]`:

- **`dep_type` weight** — reflects blast radius, not just fixability: `production → 1.0`, `peer → 0.9`, `optional → 0.6`, `development → 0.4`.
- **Transitivity discount** — `×0.9` when `is_transitive === true` _and_ the run has `no_lock_file` set in confidence flags (i.e., transitivity is inferred, not confirmed by a resolved lock file). This is a confidence discount, not a claim that transitive vulnerabilities matter less — it goes away once lock file parsing lands and transitivity is known for certain.
- **No recency modifier in v1.** `days_since_advisory` is stored on every score for transparency and future tuning, but does not move the number yet. Manufacturing an "urgency grows/decays over time" curve without data to back it would violate the explainability standard as much as hiding the number would.

### Effort label (categorical — trivial / low / medium / high)

`EffortScorer` returns a label only, no numeric score, per the existing interface. Decision table, evaluated top to bottom:

| `semver_bump` | `has_migration_guide` | `breaking_change_signals` | Label                                                                                                             |
| ------------- | --------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `patch`       | —                     | empty                     | `trivial`                                                                                                         |
| `patch`       | —                     | non-empty                 | `low` (patch claims no breaking change per semver, but changelog signals disagree — flagged, not trusted blindly) |
| `minor`       | false                 | empty                     | `low`                                                                                                             |
| `minor`       | true or false         | non-empty                 | `medium`                                                                                                          |
| `minor`       | true                  | empty                     | `low`                                                                                                             |
| `major`       | true                  | —                         | `medium` (a migration guide meaningfully lowers effort even for majors)                                           |
| `major`       | false                 | —                         | `high`                                                                                                            |
| `unknown`     | —                     | —                         | `medium` (can't assess bump size — moderate default, not optimistic)                                              |

### Ecosystem value score (0.0–10.0)

Repo popularity is heavily right-skewed, so components are log-scaled against a soft ceiling rather than scaled linearly.

- `stars_component = min(log10(repo_stars + 1) / log10(100_000) * 10, 10)` — ceiling at 100k stars.
- `engagement_component = min(log10(open_issues_count + 1) / log10(1_000) * 10, 10)` — a light community-activity signal, not a health judgment (a high count can mean either heavy use or neglect; it's not weighted heavily for that reason).
- `downstream_component = min(log10(downstream_dependents + 1) / log10(10_000) * 10, 10)` — only computed when `downstream_dependents` is non-null.

Weighting — **when `downstream_dependents` is present**:

```
ecosystem_value = stars_component * 0.50
                + downstream_component * 0.35
                + engagement_component * 0.15
```

**When `downstream_dependents` is null** (the current default — see below), the missing component is excluded and the remaining weights are renormalized rather than treating the missing value as zero:

```
ecosystem_value = stars_component * 0.75
                + engagement_component * 0.25
```

Silently defaulting an unknown value to zero would understate ecosystem value for exactly the repos we have the least data on — the opposite of what a fair scoring system should do.

### Composite score and tie-breaking

Unchanged from `scorer/interface.ts`: `composite = impact * 0.60 + ecosystem_value * 0.40`.

When two missions' composite scores are within **0.5** of each other, they are considered tied and ranked by `effort_label` ascending (`trivial < low < medium < high` — prefer the easier win), then by `mission.created_at` ascending as a final deterministic tie-breaker.

### Confidence

`confidence_flags` (from `ConfidenceFlags`) drive `confidence` directly and mechanically — no separate judgment call:

- 0 flags set → `"high"`
- 1 flag set → `"medium"`
- 2+ flags set → `"low"`

This keeps the confidence label fully derivable from the flags a user can already see, which is what the explainability standard requires — no hidden weighting between flag types.

## `downstream_dependents`: deferred, not stubbed to zero

No free, reliable data source for "packages that depend on this package" was identified during Phase 2 kickoff. The npm registry API doesn't expose it. Third-party sources (e.g. libraries.io) exist but bring their own free-tier limits and a new ingestion integration — out of scope for Phase 2, which is scoped to scoring logic against data already ingested in Phase 1.

Decision:

- `EcosystemValueInputs.downstream_dependents` stays nullable and is **not populated** in Phase 2.
- `EcosystemValueScorer` treats `null` as "exclude and renormalize" (see weighting above), never as `0`.
- A new confidence flag, `downstream_dependents_unavailable`, is added to `ConfidenceFlags` in `db/types.ts` so this limitation is visible on every mission, per the transparency-first constraint — a low-value-looking score should never be indistinguishable from a low-confidence one.
- Sourcing `downstream_dependents` (which service, ingestion cost, refresh cadence) is logged as a backlog item for a later phase, not solved here.

## Alternatives considered

| Option                                                           | Notes                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single unified 0–10 "priority" score (no impact/ecosystem split) | Rejected — collapses two independent signals ("how bad" vs. "how much does it matter to the ecosystem") into one number, which is harder to explain and was already rejected implicitly by the existing `CompositeScoreResult` shape. |
| Effort as a numeric multiplier on composite                      | Rejected in the original interface design — an easy fix to a low-impact issue shouldn't outrank a hard fix to a critical one just because it's easy. Effort stays a tie-breaker only.                                                 |
| Default `downstream_dependents` to `0` when unknown              | Rejected — see above; this would systematically understate ecosystem value for exactly the repos with the least available data.                                                                                                       |
| Linear (non-log) scaling for stars/dependents                    | Rejected — star counts span 0 to 100k+; linear scaling would make almost every repo except mega-projects score near zero on ecosystem value.                                                                                          |

## Consequences

- `packages/core/src/scorer/interface.ts`'s header comment is corrected to point at `docs/adr/0006-scoring-algorithm.md` instead of the stale `0005-scoring-algorithm.md` reference.
- `packages/core/src/db/types.ts`'s `ConfidenceFlags` interface gains `downstream_dependents_unavailable?: boolean`. This is a JSONB-shape type change only — no `schema.ts` column change, no migration required.
- `ImpactScorer`, `EffortScorer`, `EcosystemValueScorer` implementations (with unit tests) are the next Phase 2 deliverable, built directly against the formulas in this ADR.
- All weights and thresholds in this document are versioned as `scoring_version: "1.0.0"`. Any future change to a weight, ceiling, or threshold must bump this version and be captured in a superseding ADR — scores already shown to users should never silently change meaning.

## Free-tier compliance

No new services or dependencies. All formulas run in-process against data already in Postgres.
