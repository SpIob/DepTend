# ADR 0024; Go Ecosystem Detection, Manifest Scope, and Effort Scoring

**Status:** Accepted
**Date:** 2026-07-25
**Note:** Originally written and filed as "Phase 7" (title, filename, and this metadata field). The project's phased roadmap concluded at Phase 6; there is no Phase 7; work since is tracked as dated session reports instead (see `07-27-26_Go_Ecosystem_Support.md`). Title, filename, and this line corrected 2026-07-27 at Mico's direction; body text below is left as originally written and may still say "Phase 7" in places; those are incidental, not a claim that a Phase 7 exists.

---

## Context

Phase 7 adds Go as deptend's third ecosystem. Grounded against the real repo (not assumed from Phase 6's docs) before writing any code; `git log` confirms `main` is at `527ee7a` (ADR 0023, dev/prod branch separation), `ecosystemEnum` is still `["npm", "pypi"]`, and every ecosystem-generic piece of the pipeline (`EcosystemIngestor`, `detectEcosystem`, `DefaultEffortScorer`/`DefaultImpactScorer`/`DefaultEcosystemValueScorer`) is exactly as documented.

Two things this ADR treats differently from ADR 0022's PyPI work:

1. **Four hardcoded `ecosystem === "pypi"` ternaries already exist**, not two. ADR 0022 found two literal `"npm"` string bugs before Phase 6 shipped; grounding for Phase 7 found four two-way ternaries that assume exactly two ecosystems will ever exist:
   - `osv.ts:547-548`; `extractAffectedRanges()`'s range-type filter
   - `mission-scorer.ts:275-278`; `buildEffortInputs()`'s bump-inference function selection
   - `scripts/ingest.js:247-248`; registry fetcher selection
   - `cli/src/analyze.ts:74`; registry fetcher selection (CLI mirror of the above)

   None of these are compile-enforced the way `OSV_ECOSYSTEM_NAMES: Record<Ecosystem, string>` is; a third ecosystem silently falls into the `pypi`-ternary's `else` branch instead of failing to build. This ADR converts all four to exhaustive `Record<Ecosystem, ...>` form (or an equivalent switch with no `default`), so adding a fourth ecosystem later is a compile error at each site, matching the standard `OSV_ECOSYSTEM_NAMES` already set.

2. **Go turns out to need substantially less new code than PyPI did**, confirmed empirically, not assumed:
   - Go module versions are real SemVer (enforced by the Go toolchain itself, `v1.2.3` format); sandbox-verified against `node-semver@^7.8.5` (already a dependency): `semver.valid()`, `semver.validRange()`, `semver.minVersion()`, and `semver.diff()` all handle the `"v"` prefix and Go's version format directly, with no wrapper needed. `inferSemverBump()` is reused **unchanged**; no PEP-440-style new bump-inference module, no new version-comparison dependency.
   - `go.mod` is plain text, not TOML/XML; no new parsing dependency needed (unlike `smol-toml` for PyPI).
   - OSV's Go implementation supports **`SEMVER`-type ranges only** (confirmed: `golang.org/x/vuln/internal/osv`'s own doc comment states "only the SEMVER affected range type is implemented" for the Go database); no `ECOSYSTEM`-type handling needed, unlike PyPI.

## Decision 1; Ecosystem detection: append Go to the existing probing order

`detectEcosystem()` itself needs no change; it already takes an ordered list. Both callers' ingestor lists become:

- `scripts/ingest.js`: `detectEcosystem([npmIngestor, pypiIngestor, goIngestor], rawBase)`
- `cli/src/analyze.ts`: `detectEcosystem([new LocalNpmIngestor(), new LocalPyPIIngestor(), new LocalGoIngestor()], options.repoPath)`

Go tried last, after npm and PyPI; preserves every existing repo's detected ecosystem exactly as today; only repos that resolve neither `package.json` nor `pyproject.toml`/`requirements.txt` pay the extra round trip. Same accepted simplification ADR 0022 already established: a repo with manifests for more than one ecosystem detects as whichever is tried first (unchanged, not revisited here).

**Schema change:** add `'go'` to `ecosystemEnum` (`ALTER TYPE ecosystem ADD VALUE 'go'`); mechanically identical to migrations `0001` and `0002`. **New wrinkle since ADR 0023:** this is the first migration since the dev/prod Neon branch split. It needs to be applied to the `dev` branch first (local verification) and separately to the production branch (same two-step process either `drizzle-kit migrate` or the Neon SQL Editor fallback would need run twice, once per branch/connection string); not a blocker, just a new step that didn't exist for migrations `0000`–`0002`.

## Decision 2; Go manifest scope: `go.mod` `require` directives, direct only

Mirrors Phase 1/6's own scoping calls (`package.json` only; PEP 621 + `requirements.txt` only) rather than covering every Go tooling convention at once.

**Parsed:** every `require` directive; both the single-line form (`require github.com/foo/bar v1.2.3`) and grouped-block form (`require (\n\tgithub.com/foo/bar v1.2.3\n)`), confirmed against real `go.mod` files (`gorilla/mux`, `spf13/cobra`, `gin-gonic/gin`) fetched directly from `raw.githubusercontent.com` during this ADR's own grounding; real files commonly contain **multiple separate `require` blocks** in one file (gin-gonic/gin has three: one direct-deps block, one single-line indirect require, one indirect-deps block), so the parser can't assume at most one block.

**Direct dependencies only**; requires with a trailing `// indirect` comment are excluded, matching this project's existing "Phase 1/2 only ingests direct dependencies" scope (`mission-scorer.ts`'s `is_transitive: false`) and mirroring `requirements.txt`'s already-established "flat list, no built-in dev/optional distinction" precedent. All parsed dependencies map to `dep_type: "production"`; Go's `go.mod` has no dev/peer/optional concept to map to those other three enum values.

**Explicitly out of scope, same shape of deferral as npm's lock file / PyPI's Poetry table:**

- `go.sum` (the lock file); not read, matches the project's standing lock-file-parsing deferral.
- `replace`, `exclude`, `retract` directives; real, common, and deliberately not handled.
- Module paths with a major-version suffix (`github.com/foo/bar/v2`) are treated as an opaque package name, same as today's npm scoped-package (`@scope/pkg`) handling; no attempt to strip or specially interpret the `/vN` suffix.

**A genuinely empty `go.mod`** (a `module`/`go` directive with no `require` block at all; confirmed real via `gorilla/mux`'s actual file) stays `ingestionStatus: 'complete'` with zero dependencies, same precedent as npm's empty-`package.json` and PyPI's empty-`dependencies`-list cases. Only "no `go.mod` found at all" becomes `'skipped'`.

## Decision 3; Effort scoring: reuse `inferSemverBump()` unmodified

No new function, no new dependency. `buildEffortInputs()`'s ternary becomes a `Record<Ecosystem, (spec: string, target: string | null) => SemverBump>` (or equivalent switch) with `npm: inferSemverBump, go: inferSemverBump, pypi: inferPep440Bump`; `go` and `npm` literally point at the same function.

**Known, accepted gap carried over unchanged (not a Phase 7 regression):** `inferSemverBump()`'s upper-bound-only-range behavior (`"<5.4.0"` → treated as floor `"0.0.0"` → reported as `"major"`), flagged as a known, deliberately-unfixed quirk in ADR 0022's live-verification section, now also applies to any Go dependency declaring an upper-bound-only constraint. Not touched here; same reasoning ADR 0022 gave: revisiting `inferSemverBump()` is a separate, deliberate call, not a side effect of adding an ecosystem.

## Decision 4; Go registry metadata: `proxy.golang.org`, no auth, module-path case-encoding required

**New module `packages/core/src/ingestor/go-registry.ts`**, mirroring `pypi-registry.ts`'s shape: `GET https://proxy.golang.org/<encoded-module>/@latest` → `{Version, Time}` JSON, populating `latestVersion`. No per-request auth, no documented per-second rate limit (unlike crates.io, which was ruled out partly for this reason); the existing bounded-concurrency default (10) carries over unchanged.

**One real wrinkle with no npm/PyPI precedent:** the module-path element of every proxy URL must be case-encoded per the documented GOPROXY protocol; every uppercase letter replaced with `!` followed by its lowercase equivalent (e.g. `github.com/Azure/azure-sdk-for-go` → `github.com/!azure/azure-sdk-for-go`). Confirmed against `golang.org/x/mod/module`'s own source comment, not assumed. `go-registry.ts` needs a small, pure `encodeGoModulePath()` helper doing this before every request; a new piece of logic, but a mechanical, well-documented one.

**`isDeprecated`/`deprecationNote`: always `false`/`null`, documented gap**; same call as PyPI's. Go does support a `// Deprecated:` comment convention near a module's own `module` directive, but reading it would require a second network call per dependency (fetching that dependency's own `go.mod` via `@v/<version>.mod`, not just `@latest`) for a signal this project already has precedent for skipping. Not pursued in Phase 7; noted as a real, deliberately-descoped enhancement, not an oversight.

## Decision 5; OSV: `"Go"` identifier, `SEMVER`-only ranges

- `OSV_ECOSYSTEM_NAMES` (`osv.ts`) gains `go: "Go"`; already compile-enforced via `Record<Ecosystem, string>`, so this is a one-line, safe addition.
- `extractAffectedRanges()`'s accepted-range-types map becomes `Record<Ecosystem, OsvRange["type"][]>`: `npm: ["SEMVER"], pypi: ["SEMVER", "ECOSYSTEM"], go: ["SEMVER"]`; confirmed via `golang.org/x/vuln/internal/osv`'s own doc comment that Go's vulnerability database only populates `SEMVER`-type ranges, so no `ECOSYSTEM`-type handling is needed for Go (unlike PyPI). This also closes the exhaustiveness gap noted in Context #1 for this specific call site.

## What changed (planned)

- `packages/core/src/db/schema.ts` + a new Drizzle migration (`0003_*`, name TBD by `drizzle-kit generate`); `'go'` added to `ecosystemEnum`. No `repos` column change (Decision 1, unchanged reasoning from ADR 0022).
- New files, mirroring the PyPI Phase 6 set 1:1:
  - `packages/core/src/ingestor/go-parse.ts`; pure `require`-block parsing (+ `.test.ts`)
  - `packages/core/src/ingestor/go.ts`; `GoIngestor` (HTTP, GitHub raw content) (+ `.test.ts`)
  - `packages/core/src/ingestor/local-go.ts`; `LocalGoIngestor` (filesystem, for the CLI) (+ `.test.ts`)
  - `packages/core/src/ingestor/go-registry.ts`; `GoRegistryFetcher` + `encodeGoModulePath()` (+ `.test.ts`)
- Modified: `osv.ts` (Decision 5), `mission-scorer.ts` (Decision 3), `scripts/ingest.js` + `cli/src/analyze.ts` (Decision 1 + registry-fetcher selection), `packages/core/package.json` exports map (`./ingestor/local-go.js`, `./ingestor/go-registry.js`).
- No new runtime dependencies. No new devDependencies.

---

_Decisions above are proposed, not yet implemented; this file is the artifact for review before Step 1 starts, same as ADR 0022 was reviewed before Phase 6's Step 1 shipped._
