# ADR 0022; Phase 6: PyPI Ecosystem Detection, Manifest Scope, and Effort Scoring

**Status:** Accepted
**Date:** 2026-07-23
**Phase:** 6; Ecosystem Expansion

---

## Context

Phase 6 adds PyPI as deptend's second ecosystem. ADR 0003 anticipated this; _"adding PyPI requires only a new `EcosystemIngestor` implementation, not a redesign of the core pipeline"_; and grounding against the real repo at kickoff mostly confirmed that, with one gap ADR 0003 didn't anticipate and two real technical forks that needed resolving before any code:

1. **`repos` has no `ecosystem` column.** ADR 0003 said _"the `ecosystem` column in all schema tables"_ would carry this; in practice only `dependencies.ecosystem` and `advisories.ecosystem` got one. `submitRepo()` and `POST /api/repos` accept only a `githubUrl`. Nothing today decides which ingestor a submitted repo should run through.
2. **`scripts/ingest.js` and `cli/analyze.ts` both hardcode a single `NpmIngestor`/`LocalNpmIngestor`** for every repo; there's no per-repo routing logic at all yet.
3. **Effort scoring's `semver_bump` inference (`mission-scorer.ts`'s `inferSemverBump()`) calls the `semver` package directly and unconditionally** on `dependency.versionSpec`. Python version specifiers follow PEP 440 (epochs, `~=`, `.postN`, `.devN`), which `semver.validRange()` mostly can't parse; this would silently degrade `semver_bump` to `"unknown"` for most real PyPI dependencies rather than error, which is worse: a quietly-wrong effort label rather than a visible failure.
4. Two more hardcoded-`"npm"` spots that are plain bugs, not decisions: `IngestionWriter.upsertDependencies()` writes the literal string `"npm"` (writer.ts:313) instead of reading the `ecosystem` field `IngestorResult` already carries; `OsvFetcher` does the same in both its batch query (osv.ts:195) and advisory mapping (osv.ts:403).

Three decisions were needed before writing any Phase 6 code. Mico's calls:

## Decision 1; Ecosystem detection: auto-detect by ordered probing

**No `repos.ecosystem` column.** Ingestion tries `NpmIngestor` first; if it resolves a manifest (`manifest_resolved: true`; see rename below), the repo is npm and PyPI is never attempted. If npm finds nothing, it tries a `PyPIIngestor` next. If neither resolves, the repo lands on `ingestionStatus: 'skipped'`, same as today, with a warning naming both things that were tried.

This turns out to compose cleanly with the schema as it already exists:

- `dependencies.ecosystem` and `advisories.ecosystem` are already per-row, exactly as ADR 0003 intended; since exactly one ingestor "wins" per repo under ordered probing, every dependency/advisory row written for a given ingestion run shares one ecosystem, so no per-row ambiguity is introduced.
- The **only schema change this decision needs is adding `'pypi'` to the existing `ecosystem` enum**; mechanically identical to ADR 0021's `'skipped'` addition (`ALTER TYPE ecosystem ADD VALUE`), including the same three infrastructure hurdles to watch for (`.env.local` loading in `drizzle.config.ts`, the `neon-serverless`-in-CLI hang, the possible second unexplained hang); already solved once, just needs re-running, not re-solving.
- `repos` genuinely doesn't need an `ecosystem` column: which ecosystem(s) a repo has is a fact about its dependencies/advisories, not the repo itself, and that's already where it's recorded.

**Explicit, accepted simplification:** a repo with _both_ a `package.json` and a `pyproject.toml`/`requirements.txt` at its root will be detected as npm-only; npm is tried first and wins outright. True multi-ecosystem-per-repo support (running every applicable ingestor, not stopping at the first match) is out of scope for Phase 6; noted below as a real follow-on, not a bug.

**Cost:** a repo that isn't npm now costs one extra GitHub raw-content round trip (the failed `package.json` fetch) before PyPI is tried. Negligible at the current repo cap (10, per ADR 0020) and well within GitHub's authenticated rate limit.

## Decision 2; PyPI manifest scope: `pyproject.toml` (PEP 621) + `requirements.txt` fallback

Mirrors Phase 1's own scoping call for npm (`package.json` only, lock files deferred) rather than trying to cover every Python packaging convention at once.

**Primary source; `pyproject.toml`, PEP 621 tables only:** `[project.dependencies]` (a list of PEP 508 strings) and `[project.optional-dependencies]` (a dict of extra-name → list of PEP 508 strings), parsed the same way `parsePackageJsonContent()` treats `dependencies`/`devDependencies`/etc.; `optional-dependencies` entries map to `dep_type: "optional"`, `dependencies` entries map to `"production"`. **Poetry's `[tool.poetry.dependencies]` table (non-PEP-508 syntax, e.g. `^1.4.2`) is explicitly out of scope for Phase 6**; same shape of deferral as npm's lock-file parsing, not a bug to fix later so much as a real scoping boundary to revisit if it turns out to matter.

**`requirements.txt` fallback; triggers in two cases, not one:**

1. No `pyproject.toml` found at all (mirrors npm's "no manifest" case exactly).
2. `pyproject.toml` exists, parses as valid TOML, but has no `[project.dependencies]` key at all; covers Poetry-style and other non-PEP-621 tables, which otherwise would look like "a real project with zero dependencies" (wrongly landing on `'complete'`) rather than "we don't parse this tool's format" (should fall through and try `requirements.txt` before giving up).

A `pyproject.toml` with a `[project]` table that declares `dependencies = []` explicitly (genuinely empty, PEP-621-valid) stays `'complete'` with zero dependencies; same precedent as npm's genuinely-empty-`package.json` case. `requirements.txt` parsing covers plain `name==version`/`name>=version` lines (all mapped to `dep_type: "production"`; requirements.txt has no built-in dev/optional distinction); lines starting with `-r`, `-e`, `--hash`, or `#` are skipped with a warning rather than treated as a package.

**New dependency: `smol-toml` (`^1.7.0`, BSD-3-Clause, zero runtime dependencies of its own, actively maintained; last published 2026-06-21).** No dependency-free path exists for correct TOML parsing (same reasoning ADR 0007 §4 used for `semver`: hand-rolling TOML's quoting/multiline/array-of-tables rules is real parser work, not worth re-deriving badly).

## Decision 3; Effort scoring: a small PEP 440-aware diff, not a `semver` proxy

**New dependency: `@renovatebot/pep440` (`^5.0.0`, Apache-2.0, zero runtime dependencies of its own, published 2026-05-08; actively maintained; it's the PEP 440 implementation powering Renovate in production, a strong real-world reliability signal).** Confirmed via its actual `.d.ts` exports before committing to it; it gives exactly the primitives `inferSemverBump()` already relies on from `semver`, just for PEP 440:

- `major()`, `minor()`, `patch()`; numeric accessors on a version string (this library's own semantic-diff layer, not something built by hand).
- `compare()`; standard `-1`/`0`/`1` comparator.
- `validRange()` and `specifier.parse()` (→ structured `{operator, prefix, version}[]` per constraint); used to build a `inferPep440Floor()` helper that plays the same role `semver.minVersion()` plays today: pick the constraint with the most restrictive lower bound (`>=`, `==`, `~=`, `>`) as the "current" proxy version.

`mission-scorer.ts`'s `buildEffortInputs()` branches on `ctx.dependency.ecosystem` (already present on the `Dependency` row; no new field needed) and calls either the existing `inferSemverBump()` or a new, structurally parallel `inferPep440Bump()` that classifies major/minor/patch by comparing `major()`/`minor()`/`patch()` between the floor and target versions; same decision shape as today's function, different underlying library. `effort.ts`'s `DefaultEffortScorer` itself needs no change at all: it already only sees the categorical `semver_bump: "major" | "minor" | "patch" | "unknown"` output, never the raw version strings.

**Known, accepted gap:** PEP 440's `release` segment is arbitrary-length (`1.2`, `1.2.3.4` are both valid), unlike semver's fixed three. `major()`/`minor()`/`patch()` collapse this to a 3-slot view; a documented simplification, not a silent one, mirroring how `effort.ts`'s own decision table is explicitly categorical rather than trying to capture every real nuance.

### Live-verification finding: upper-bound-only ranges (2026-07-25)

Found during Step 8 live verification against a real fixture (`pyyaml<5.4`, 8 real OSV advisories); not anticipated at design time, worth recording precisely rather than only in chat history.

A specifier with no lower bound at all (`<5.4`; no `>=`/`==`/`~=`/`>`/`===` clause anywhere) has nothing for `extractPep440Floor()` to anchor on, so `inferPep440Bump()` correctly returns `"unknown"`. Compared directly against node-semver's equivalent behavior for the analogous npm case:

```
node-semver:  minVersion("<5.4.0")  → "0.0.0"  → inferSemverBump() would call this a "major" bump
pep440 (new): no floor clause found → null     → inferPep440Bump() calls this "unknown"
```

`inferSemverBump()` has always silently treated an unbounded-below range as "floor = 0.0.0," then computed a bump off that fiction; this was never visible before because `<X`-only ranges are rare in npm's own idioms (caret/tilde/exact dominate there). They're far more common in PyPI's idioms, which is how live verification surfaced this gap on the very first real fixture tried.

**Decision:** leave the inconsistency as-is. `"0.0.0"` isn't real data; it's a mechanical artifact of the range having no explicit floor, and treating it as a genuine floor overstates the change (a real pre-5.4 PyYAML install is far more likely to be 5.3.x than 0.0.0; the honest bump is probably tiny, not "major"). `inferPep440Bump()`'s `"unknown"` is the more epistemically honest answer of the two; `inferSemverBump()`'s `"major"` is the one that's arguably been quietly overconfident all along. Not fixing `inferSemverBump()` to match right now; that's shipped, verified Phase 2 code, and revisiting it is a separate, deliberate call for later, not a Phase 6 side effect. Mico's explicit choice over two other options (make pep440 mirror npm's 0.0.0 convention; fix npm to also return unknown).

## What changed (planned)

- Root `package.json`; add `@renovatebot/pep440@^5.0.0`, `smol-toml@^1.7.0` as runtime dependencies, alongside `semver`. Confirmed against the real file: shared runtime deps consumed by `packages/core` live at the workspace root, not in `packages/core/package.json` (which declares no `dependencies` at all, only `devDependencies`); this project's own established convention, not a new pattern being introduced here.
- `packages/core/src/db/schema.ts` + a new Drizzle migration; `'pypi'` added to the `ecosystem` enum. No `repos` column change (Decision 1).
- `packages/core/src/ingestor/interface.ts`; `IngestorResult.package_json_resolved` renamed to `manifest_resolved` (generic; it's referenced by name in `writer.ts`'s status-derivation logic and in every ingestor's return shape, so this touches `npm-parse.ts`, `writer.ts`, and existing tests, not just new PyPI code).
- `packages/core/src/ingestor/pypi-parse.ts` (new); pure `pyproject.toml`/`requirements.txt` parsing, mirrors `npm-parse.ts`'s shape and its "pure, no I/O" discipline.
- `packages/core/src/ingestor/pypi.ts` (new, HTTP-based `PyPIIngestor`) and `local-pypi.ts` (new, filesystem-based `LocalPyPIIngestor`); mirror `npm.ts`/`local-npm.ts`'s fetch/parse split exactly.
- `packages/core/src/ingestor/pypi-registry.ts` (new, `PyPIRegistryFetcher`); hits `https://pypi.org/pypi/<project>/json`, same bounded-concurrency pattern as `registry.ts`. **Known scoping gap:** PyPI has no package-level "deprecated" flag analogous to npm's; `isDeprecated`/`deprecationNote` will be `false`/`null` for every PyPI dependency in Phase 6 rather than guessed at from a release's `yanked` flag (which means something narrower; one release pulled, not "don't use this package"). Documented, not silent; same treatment `downstream_dependents: null` got in ADR 0006.
- `packages/core/src/ingestor/osv.ts`; ecosystem parametrized instead of hardcoded; internal mapping `npm → "npm"`, `pypi → "PyPI"` (OSV's exact required casing, confirmed against `osv-schema`'s own validation pattern; this is not a guess).
- `packages/core/src/ingestor/writer.ts`; `upsertDependencies()` reads `ingestorResult.ecosystem` instead of hardcoding `"npm"`; `WriteIngestionInput`'s registry-result field generalized to accept either fetcher's result (same `{metadata, warnings}` shape already).
- `packages/core/src/ingestor/detect.ts` (new); the ordered-probing router: tries a list of `EcosystemIngestor`s in sequence, returns the first `manifest_resolved: true` result, else the last attempt with combined warnings. Shared by both callers below so this logic exists exactly once.
- `scripts/ingest.js`, `cli/src/analyze.ts`; both replace their single hardcoded `NpmIngestor`/`LocalNpmIngestor` with the new router, and pick the matching registry fetcher based on the winning ingestor's `.ecosystem`.
- `packages/core/src/scorer/mission-scorer.ts`; new `inferPep440Bump()` + `inferPep440Floor()`; `buildEffortInputs()` branches on `ctx.dependency.ecosystem`; the hardcoded _"The npm registry did not return complete metadata"_ confidence-note string generalized to name the actual ecosystem's registry.

## Consequences

- `EcosystemIngestor`, `DefaultEffortScorer`/`DefaultImpactScorer`/`DefaultEcosystemValueScorer`, and the `'skipped'`-status pattern from ADR 0021 all needed **zero changes**; the strongest confirmation yet that Phase 0's generic-interface bet (ADR 0003) actually paid off where it was supposed to.
- OSV's batch query can stay a single ecosystem string per call (not per-dependency); a direct, simplifying consequence of Decision 1's "one ecosystem wins per repo" rule.
- Two real follow-ons this ADR deliberately doesn't take on, worth naming so they don't get silently assumed later: (1) true multi-ecosystem-per-repo support, if a real repo ever needs it; (2) Poetry-native `pyproject.toml` parsing, if `requirements.txt`-fallback coverage turns out to be insufficient in practice.
- No dashboard change is in scope here (no ecosystem badge/filter on the board); Phase 6's exit criteria are ingestor + re-met Phase 1–5 criteria, not new UI surface.
- **Found during install, not just assumed:** `@renovatebot/pep440@5.0.0`'s own `package.json` declares `engines.pnpm: ">=10.0.0"`, ahead of this project's pinned `pnpm@9.15.0`. Tested directly; `pnpm add -w` installs and builds cleanly since `engine-strict` isn't set anywhere in this repo, so it's not a blocker. Flagged here so it isn't a surprise if `engine-strict` is ever turned on, or if a future `pnpm` upgrade decision comes up.

## Alternatives considered

| Decision            | Alternative                                              | Why not                                                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ecosystem detection | `repos.ecosystem` column, chosen at submission           | Real schema migration + form UI change for a fact the system can determine itself from what's actually in the repo; more state to keep consistent (what happens if a submitter guesses wrong?) for no accuracy benefit over probing.     |
| Ecosystem detection | Multi-ecosystem per repo (run every applicable ingestor) | Most accurate long-term, but no real deptend.dev repo has needed it yet, and it complicates the "one manifest_resolved result per run" flow this ADR otherwise keeps simple. Deferred, not rejected.                                     |
| PyPI manifest scope | Poetry `[tool.poetry.dependencies]` support in Phase 6   | Non-PEP-508 version syntax (`^`, `~`) would need its own translation layer on top of everything else here; `requirements.txt` fallback covers a meaningful slice of real Poetry projects (many still export or maintain one) without it. |
| Effort scoring      | Coerce PEP 440 strings through `semver`                  | Silent wrong answers (`"unknown"` for most real specs) rather than a visible failure — worse than the cost of one more well-vetted, zero-dependency library.                                                                             |
| Effort scoring      | Hand-roll PEP 440 parsing                                | Exactly the kind of "riskier than a zero-dependency, actively-maintained package built for this" call ADR 0007 §4 already made once for semver; no reason to make the opposite call here.                                                |

---

_End of document; draft, pending Mico's confirmation before implementation begins._
