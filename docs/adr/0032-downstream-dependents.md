# ADR 0032; Sourcing `downstream_dependents` via libraries.io

**Status:** Accepted
**Date:** 2026-08-22

---

## Context

`EcosystemValueInputs.downstream_dependents` has been `null` for every mission since Phase 2 (ADR 0006), unconditionally setting `downstream_dependents_unavailable` in `ConfidenceFlags`. Combined with `no_lock_file` (also unconditional today; `dependencies.resolved_version` is always null while lock file parsing stays deferred, ingestor/writer.ts), **every mission has shown `confidence: "low"` continuously**, including after ADR 0029. A code-level correction to the record: ADR 0029's own text and the CHANGELOG entry for it claim missions with resolvable inputs "can reach medium" post-0029; that does not hold against the source, because the downstream flag it left untouched was the second of two always-set flags. This ADR is what actually moves missions off `low`.

Grounding against the real repo before proposing anything surfaced:

1. **The scorer needs zero logic changes.** `EcosystemValueScorer` has had the with/without-downstream weight split (`0.50/0.35/0.15` vs `0.75/0.25`) and its log component against a 10,000 ceiling since scoring_version 1.0.0. Filling in real data activates existing behavior; formula, weights, ceilings, and `SCORING_VERSION` are all unchanged.
2. **Semantics are settled by ADR 0006's design, not chosen here.** The input sits alongside `repo_stars`/`open_issues_count`; analyzed-repo facts; and the ecosystem-value score measures how much _this repo's_ maintenance matters to the broader ecosystem. So the count is of dependents on **the analyzed repo's own published package(s)**, not on a dependency within it. (Per-dependency counts would be a different, more per-mission-discriminating signal, but would change score semantics mid-flight and cost thousands of calls per run; see Alternatives.)
3. **Source availability.** deps.dev's v3 REST API exposes no dependent counts at all (their Dependents data lives only in BigQuery; a GCP account with billing). npm/PyPI/Go registry APIs expose nothing reverse-dependency-shaped. That leaves libraries.io; exactly as ADR 0006 predicted; whose free tier (account signup, no credit card) provides an API key at 60 requests/minute. Mico accepted the new-account decision point and obtained a key before implementation began.

## Decision 1; Data source: one paginated libraries.io listing per analyzed repo

`GET https://libraries.io/api/github/{owner}/{name}/projects?api_key=…` returns the GitHub repo's registry-linked projects, each carrying its own `dependents_count`. One listing resolves the whole question per repo per run; at the current 150-repo cap even multi-page repos stay well inside budget. No manifest-parser changes anywhere; the repo→package linkage is libraries.io's, not ours to recompute.

**Pagination is not optional** (live-verified against the real endpoint during implementation): the default page size is **30**, and popular repos link dozens of junk packages whose metadata merely points at them; `expressjs/express` links 76 entries, of which the real `express` package (`dependents_count` ≈ 174k) is _not_ on the first page. The fetcher therefore requests `per_page=100` and walks pages until the listing runs out, capped at 5 pages (~500 entries). Two honesty rules fall out of the max-over-pages aggregation:

- A scan that ends because the listing ran out (< 100 items) is complete → its max is stored.
- A scan stopped by the page cap on a still-full page, or broken mid-way by an error, is incomplete → **null + warning**, never max-of-what-we-saw. A truncated max would store a misleadingly low number as real, checked data (flag cleared); unavailable beats wrong.
- Every page request is paced under the shared 60 req/min client-side floor; a 429 gets one Retry-After-honoring retry, then degrades to null + warning.

**Monorepos:** a repo may link several packages. The score takes the **max** `dependents_count` across them; the most-depended-upon package bounds the repo's ecosystem footprint; summing would double-count shared dev-only packages. Junk cross-platform links (spam packages pointing at popular repos) don't distort a max: they carry small counts.

**Zero vs unavailable, kept strictly distinct** (ADR 0006's never-default-to-zero rule):

| Outcome                                                                                   | Stored value | Flag    |
| ----------------------------------------------------------------------------------------- | ------------ | ------- |
| Linked project(s) found, max count is 0                                                   | `0`          | cleared |
| Linked project(s) found, positive count                                                   | that count   | cleared |
| Empty project list / repo unknown to libraries.io (404) / app repo that publishes nothing | `null`       | set     |
| No key configured / network error / rate-limited past one retry / malformed response      | `null`       | set     |

An unpublished app has no package to count dependents _of_, so "not found" is unavailable, not zero; but a published library reporting zero dependents gets a real, checked 0; "checked, found nothing" is information, same philosophy as ADR 0029 Decision 4.

## Decision 2; Architecture: same prefetch-before-transaction shape as ADR 0029

New `packages/core/src/ingestor/downstream-dependents.ts`: `fetchDownstreamDependents({owner, name}, apiKey)` → `{ count: number | null; warnings: string[] }`, never throws, module-level pacing (≥1100 ms between calls in-process). `MissionScoringContext` gains one optional field:

```ts
downstreamDependents?: number; // prefetched externally, absent means "unavailable"
```

`buildEcosystemValueInputs()` maps it through (`?? null`); `deriveConfidenceFlags()` becomes conditional:

```ts
if (ctx.downstreamDependents === undefined) {
  flags.downstream_dependents_unavailable = true;
}
```

`MissionWriter.generateMissionsForRepo()` performs the fetch itself; the repo row (owner/name) is already loaded there, and writer.ts is the established prefetch glue point (ADR 0029 Decision 2); before `db.transaction()` opens, skipped entirely (zero network calls) when no key was passed or when there are zero candidates. The fetch is per-repo, not per-candidate, so unlike ADR 0029 no keying/dedup machinery is needed. Lookup failures surface as a new `warnings` field on `GenerateMissionsOutput` for `scripts/ingest.js` to log, never failing the run (ADR 0008 §5 semantics preserved).

## Decision 3; Scope: ingestion paths with a key; CLI unchanged

`LIBRARIES_IO_API_KEY` is read by `scripts/ingest.js` (warn-at-startup when absent, mirroring the `GITHUB_TOKEN` pattern) and mapped into `.github/workflows/ingest.yml` from Actions secrets. `/app` never touches it; no API route needs it. **`@deptend/cli` stays unchanged**: it is account-free/in-memory by design and has no secrets infrastructure; CLI output keeps the flag set and the note text, documented as a known gap rather than given an opt-in env var Mico didn't ask for.

## What changed

- `packages/core/src/ingestor/downstream-dependents.ts`; new. Paginated fetch (per_page=100, ≤5 pages) + pacing + retry-once-on-429 + max-across-monorepo + complete-vs-incomplete-scan and zero/unavailable distinctions; `resetDownstreamDependentsPacing()` exported for tests.
- `packages/core/src/ingestor/downstream-dependents.test.ts`; new. 24 cases covering every row of Decision 1's table, request shape, pagination aggregation/cap/mid-scan-failure rules, 429 handling incl. Retry-After honoring, and pacing.
- `packages/core/src/scorer/mission-scorer.ts`; `MissionScoringContext.downstreamDependents?`; conditional flag; confidence note wording updated to name the repo's published package; header ADR references.
- `packages/core/src/scorer/writer.ts`; 4th optional parameter `librariesIoApiKey`; pre-transaction prefetch; `GenerateMissionsOutput.warnings`.
- `packages/core/src/db/json-types.ts`; doc comments only (shape unchanged).
- `scripts/ingest.js`; env read + startup warning + pass-through + warnings logging.
- `.github/workflows/ingest.yml`; secret mapping.
- Tests updated: `mission-scorer.test.ts` (flag conditionality, genuine-0, first-ever zero-flag/high-confidence path), `writer.test.ts` (prefetch wiring, backward compat, ordering, warnings field on all four exact-match assertions).

**No schema migration. No scorer formula change. No `/app` change. No ranking/SQL change** (the board reads stored composite scores; values refresh naturally per-repo on each ingestion run).

## Consequences

- Missions for repos whose package resolves on libraries.io drop to one structural flag (`no_lock_file`) → **`medium` for the first time ever**; combined with lock-file parsing (still deferred) they can reach `high`. Everything else stays `low`, honestly.
- Ecosystem-value scores shift upward for well-depended-upon library repos once their count lands (the 0.35-weight component activates); board order changes accordingly, transparently, with the count visible in "Why this score?".
- New third-party dependency in the ingestion path: libraries.io outages degrade to `null`+flag, never failed runs. Its repo↔package linkage is imperfect; polluted with junk links (handled by max-aggregation) and missing for some published repos (reads as unavailable, which understates nothing, renormalized weights, hides nothing, flag visible).
- The stale CHANGELOG/ADR 0029 claims about post-0029 `medium` confidence are corrected here rather than silently; §11 of AGENTS.md updated in the same pass.
- Pacing state is process-global: correct for production's sequential per-repo flow, and reset explicitly between writer tests.

## Alternatives considered

| Decision        | Alternative                                          | Why not                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data source     | deps.dev API                                         | v3 REST exposes no dependent counts; BigQuery path requires a GCP billing account — fails the zero-budget constraint outright.                                                                                        |
| Semantics       | Dependents of the _dependency_ package, not the repo | More discriminating per mission, but changes settled score semantics mid-flight (scoring_version bump territory) and scales with unique-dependency count (thousands of throttled calls per full run), not repo count. |
| Monorepo rule   | Sum of linked packages' counts                       | Double-counts shared/dev-only packages; overstates footprint. Max is conservative and explainable in one sentence.                                                                                                    |
| Persistence     | Cache counts in a new table/column                   | Schema migration + staleness logic for data this project's precedent derives fresh each run (`detectEcosystem`, `sourceRepo`); one cheap call per repo per daily run doesn't justify either.                          |
| Writer plumbing | Fetch in `scripts/ingest.js`, pass the number in     | Splits mission-score input acquisition across two layers; writer.ts already loads the repo row and owns ADR 0029's prefetch — keeping both acquisitions together preserves one glue point.                            |
| Scope           | Optional `LIBRARIES_IO_API_KEY` opt-in for the CLI   | The CLI has no config/secrets surface by design; adding one for a signal that mostly benefits the persistent dashboard wasn't requested. Revisit if npx output fidelity ever matters.                                 |

---

_End of document._
