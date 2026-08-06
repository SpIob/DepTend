# ADR 0029 — Sourcing `has_migration_guide` / `breaking_change_signals` via GitHub Releases

**Status:** Accepted
**Date:** 2026-08-03

---

## Context

`EffortInputs.has_migration_guide` and `.breaking_change_signals` have been hardcoded (`false` / `[]`) for every mission since Phase 2 (ADR 0007 §5), unconditionally setting `breaking_change_signals_unavailable` in `ConfidenceFlags`. Combined with `downstream_dependents_unavailable` (also unconditional, ADR 0006), every mission has shown `confidence: "low"` since Phase 2, across all three ecosystems — the single oldest, most user-visible gap in the project (`DepTend_v1_0.md` §14, `Roadmap.md` "Next" #1).

Grounding against the real repo (`main` @ `4fdf58f`) before proposing anything surfaced two things worth stating up front:

1. **Both scorers already fully support real data for either input.** `EcosystemValueScorer` already has the with/without-`downstream_dependents` weight split; `EffortScorer`'s decision table already branches on `has_migration_guide`/`breaking_change_signals`. Whichever gets sourced needs **zero scorer-logic changes** — this is purely an ingestion-and-plumbing problem.
2. **`downstream_dependents`'s only realistic source (ADR 0006's own text: libraries.io) needs a new third-party account**, and a real prerequisite doesn't exist yet either — nothing in this codebase tracks what package a repo itself publishes (`npm-parse.ts` never reads `package.json`'s own `name` field). `has_migration_guide`/`breaking_change_signals` has a genuinely free path — GitHub Releases, via the same `GITHUB_TOKEN` infra `github-meta.ts` already uses — and it's about the _dependency's_ upstream repo, which every candidate mission already has a name for. Mico's call: pursue breaking-change signals, all three ecosystems, PyPI best-effort.

## Decision 1 — Data source: GitHub Releases, no new account

`GET /repos/{owner}/{repo}/releases` against the **dependency's own upstream repo** (e.g. `lodash/lodash`, not the analyzed repo), reusing the exact `GITHUB_TOKEN` / 5,000-req/hr-authenticated pattern `github-meta.ts` already established. No new secret, no new account, no new dependency.

**Resolving a dependency's GitHub repo, per ecosystem — no new network calls, all from data already being fetched:**

| Ecosystem | Source                                                                                                                                                                       | Reliability                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| npm       | `registry.npmjs.org/<pkg>/latest`'s `repository` field — already fetched by `registry.ts` for `latestVersion`/`isDeprecated`; just read one more field off the same response | Good — most npm packages declare it                                        |
| Go        | The module path itself (`go-parse.ts` already has it) — `github.com/gorilla/mux` _is_ the repo location for the large majority of real Go modules                            | Good, but not universal (`golang.org/x/...`, `gopkg.in/...` don't resolve) |
| PyPI      | `pypi.org/pypi/<project>/json`'s `info.project_urls` (scanned for a `github.com` value) with `info.home_page` as fallback — already fetched by `pypi-registry.ts`            | Best-effort — not always present, not always GitHub                        |

A small shared parser (new `packages/core/src/ingestor/source-repo.ts`) normalizes whatever form each ecosystem hands it — npm's `git+https://...`, `github:owner/repo` shorthand, bare `owner/repo` shorthand, plain HTTPS URLs — into `{ owner, name } | null`. Anything that doesn't resolve to a `github.com` host returns `null`, same treatment across all three ecosystems (no special-casing PyPI as "worse" — it's just the same `null` path Go's non-GitHub module paths already hit).

**Not persisted to the DB.** `dependencies` gains no new column. `sourceRepo` is recomputed in-memory on every ingestion run from data already being fetched, the same way `detectEcosystem` decides ecosystem fresh every run rather than storing it on `repos`. **No schema migration, no change to either Neon branch.**

## Decision 2 — Architecture: prefetch before the transaction, not inside `computeMissionScore`

`computeMissionScore()` is pure/sync today and `MissionWriter.generateMissionsForRepo()` calls it once per `(dependency, advisory)` candidate **inside an open `db.transaction()`**. Network calls to arbitrary third-party GitHub repos can't happen in there — a slow or hanging external fetch would hold a Neon connection open for no good reason.

`MissionScoringContext` gains one new **optional** field:

```ts
export interface MissionScoringContext {
  dependency: Dependency;
  advisory: Advisory;
  repo: Repo;
  effortSignals?: EffortSignals; // NEW — prefetched externally, absent means "not attempted"
}
```

`buildEffortInputs()` / `deriveConfidenceFlags()` stay synchronous — they just read `ctx.effortSignals` if present. `computeMissionScore()` itself doesn't change shape or become async. This keeps the change backward-compatible by construction: any caller that doesn't pass `effortSignals` (an un-updated test fixture, a future caller) gets exactly today's behavior (`false` / `[]`, flag set) rather than a type error or a silent wrong answer.

The actual fetch is a new prefetch stage, run **before** `this.db.transaction(...)` opens:

```ts
export interface EffortSignals {
  has_migration_guide: boolean;
  breaking_change_signals: string[];
  /** false = no resolvable repo, or the fetch failed/hit a rate limit */
  source_available: boolean;
}

export async function prefetchEffortSignals(
  candidates: { dependency: Dependency; advisory: Advisory }[],
  sourceRepoByPackage: Map<string, SourceRepoRef | null>,
  token: string | null,
  concurrency = 10, // same DEFAULT_CONCURRENCY convention as registry.ts/pypi-registry.ts/go-registry.ts
): Promise<Map<string, EffortSignals>>; // keyed `${dependencyId}:${targetVersion}`
```

`sourceRepoByPackage` is built from the registry-fetcher results **already sitting in memory** at the point `scripts/ingest.js` / `cli/analyze.ts` call the registry fetcher — passed straight through to `MissionWriter.generateMissionsForRepo(repoId, sourceRepoByPackage)` as a new optional parameter, rather than re-fetching registry metadata a second time just to recover the repo field.

Keyed by `dependencyId:targetVersion`, not just `dependencyId`, because two different advisories on the same dependency can carry different `fixedVersion`s (`targetVersion = advisory.fixedVersion ?? dependency.latestVersion`) — this avoids returning stale signals for the wrong target.

**Prefetch is scoped to `is_affected` candidates only** — the same candidate set `generateMissionsForRepo` already reads, not every dependency in the repo. Added GitHub API load is proportional to missions produced, not repo size.

## Decision 3 — Release range + signal extraction (implementation detail, not a sign-off point)

For a resolved `{owner, name}`, fetch releases newest-first, paginated, and stop at the first release older than the current-version floor (same per-ecosystem comparator `inferSemverBump`/`inferPep440Bump` already use) **or** a hard cap of 5 pages (~500 releases) — whichever comes first. Bounds worst-case calls per dependency to a handful, not one call per intervening version.

- `has_migration_guide`: any release-in-range's body matches a small set of phrase patterns (`migration guide`, `upgrade guide`, `UPGRADING`, a `## Migration` heading).
- `breaking_change_signals`: lines matching conventional patterns (`BREAKING CHANGE:`, a `### Breaking Changes` section's bullets), capped at 5 entries, each truncated to a reasonable length, so `mission_scores.effort_inputs` stays bounded.

Exact regexes get finalized against real release bodies during implementation, with tests — flagged here as a detail Mico doesn't need to sign off on line-by-line, same treatment ADR 0027 gave bookmark sort order.

## Decision 4 — Confidence flag becomes conditional, not unconditional

`deriveConfidenceFlags()` currently sets `breaking_change_signals_unavailable = true` for every mission, no exceptions. New rule:

```ts
if (ctx.effortSignals === undefined || ctx.effortSignals.source_available === false) {
  flags.breaking_change_signals_unavailable = true;
}
```

A mission whose dependency has no resolvable GitHub repo (a real, expected outcome — especially for PyPI) still correctly shows the flag and the existing confidence-note sentence. This is not a change to `ConfidenceFlags`'s JSONB shape, just to when the flag gets set — `downstream_dependents_unavailable` is untouched and stays unconditional, so **`confidence: "low"` will not disappear project-wide**, but missions with a resolvable dependency repo drop from 2 flags to 1 (`medium`), and — combined with a fully-resolved lock file and CVSS score — some will reach 0 (`high`) for the first time since Phase 2.

## What changed (planned)

- `packages/core/src/ingestor/source-repo.ts` — new. `parseSourceRepo()` normalizer, shared by all three registry fetchers.
- `packages/core/src/ingestor/registry.ts` / `pypi-registry.ts` / `go-registry.ts` — `PackageMetadata` gains `sourceRepo: SourceRepoRef | null`, populated from data each fetcher already receives.
- `packages/core/src/ingestor/changelog-signals.ts` — new. `fetchReleaseSignals()` (one dependency) + `prefetchEffortSignals()` (bounded-concurrency batch, mirrors the existing registry fetchers' concurrency pattern).
- `packages/core/src/scorer/mission-scorer.ts` — `MissionScoringContext.effortSignals` (new, optional); `buildEffortInputs()` and `deriveConfidenceFlags()` read it.
- `packages/core/src/scorer/writer.ts` — `generateMissionsForRepo()` gains an optional `sourceRepoByPackage` parameter; prefetch call added before `db.transaction()` opens; per-candidate lookup inside the loop stays synchronous.
- `scripts/ingest.js` — builds `sourceRepoByPackage` from the registry-fetcher result already in memory, passes it through.
- `cli/src/analyze.ts` / `build-rows.ts` — same shape, no DB/transaction concerns on this path.
- New/updated tests: `source-repo.test.ts`, `changelog-signals.test.ts`, plus additions to `registry.test.ts`, `pypi-registry.test.ts`, `go-registry.test.ts`, `mission-scorer.test.ts`, `scorer/writer.test.ts`, `cli/analyze.test.ts`, `cli/build-rows.test.ts`.
- **No schema migration. No `.env.example` change. No new dependency.**

## Consequences

- Confidence stops being uniformly `"low"` for the first time since Phase 2 — but only partially: `downstream_dependents_unavailable` is untouched by this ADR, so `high` confidence requires that gap to close too, separately, later.
- PyPI missions will show `breaking_change_signals_unavailable: true` more often than npm/Go ones, by design (best-effort per Decision 1) — worth watching whether that reads as "PyPI is second-class" once it's visible on a dashboard; not a reason to block this ADR, a reason to note if it comes up.
- Added GitHub API load is real but bounded (Decision 2's candidate-scoping, Decision 3's pagination cap) — worth a quick sanity check against real rate-limit headroom during implementation, especially now that the repo cap sits at 150 (`Marketing_Plan.md`), not 10.
- `MissionWriter.generateMissionsForRepo()`'s public signature changes (new optional parameter) — `scorer/writer.test.ts`'s existing calls stay valid unchanged (optional param), but new tests are needed for the prefetch path itself.

## Alternatives considered

| Decision               | Alternative                                             | Why not                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direction              | `downstream_dependents` (libraries.io)                  | New third-party account for a signal that's structurally `0`/null for any analyzed repo that's an application rather than a published library — lower payoff, higher cost. Mico's call, not overridden here.                |
| Source-repo resolution | Persist `sourceRepo` as a new `dependencies` column     | Schema migration for a fact this project already has a strong precedent for deriving fresh each run instead (`detectEcosystem`, ADR 0022 Decision 1) — no accuracy benefit over recomputing it from data already in memory. |
| Architecture           | Make `computeMissionScore()` itself async, fetch inline | Would put arbitrary third-party network calls inside `MissionWriter`'s open `db.transaction()` — exactly the kind of thing ADR 0009 exists to avoid holding a Neon connection open for.                                     |
| Scope                  | Go-only or Go+npm for v1, PyPI deferred entirely        | Mico's explicit call: all three now, PyPI best-effort rather than absent — consistent with how PyPI/Go themselves shipped (best-effort gaps documented, not blocking).                                                      |

---

_End of document — draft, pending Mico's confirmation before implementation begins._
