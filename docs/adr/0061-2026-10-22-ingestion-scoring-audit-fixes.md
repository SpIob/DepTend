# ADR 0061: 2026-10-22 Ingestion and Scoring Audit Fixes

**Status:** Accepted (live-verified 2026-10-22 — see Live verification)
**Date:** 2026-10-22
**Phase:** Post-launch audit

---

## Context

A full audit of `packages/core/src` (ingestor + scorer) against production
data (Neon `br-square-hill-aovhsm68`, 2026-10-22) surfaced six defects and
gaps, of which one was an accepted-but-never-implemented ADR:

| #   | Finding                                                                                                                                                                                                | Production evidence (2026-10-22)                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 1   | ADR 0039 (EPSS) was Accepted with **zero implementation** — `advisories.epss_score` existed, the impact scorer consumed it, but no pipeline stage ever fetched it                                      | 0/172 advisories had `epss_score` populated                                          |
| 2   | OSV batch queries sent package name only, so every advisory ever recorded against a package matched, even on fully patched installs (`isAffected: true` blanket, `match_method` always `version_spec`) | `lodash` name-only → 10 vulns; `lodash@4.17.21` (fixed) → 3                          |
| 3   | `resolvePending()` re-picked only `pending`/`failed`; a crashed/cancelled workflow run left a repo stuck at `ingestionStatus: 'running'` forever                                                       | n/a (latent; `withdrawOwnRepo` even tells users "running resolves itself shortly")   |
| 4   | CVSS v4 vectors were rejected by `cvssVectorToBaseScore`, so affected advisories fell to severity `unknown` / impact floor 1.0                                                                         | 5 PYSEC-2026 advisories carried full `CVSS:4.0/…` vectors, all at severity `unknown` |
| 5   | Effort-signal prefetch covered `vulnerability_fix` only, so every `dep_update` mission carried `breaking_change_signals_unavailable` and was structurally capped at `low` confidence                   | 0/193 missions at `high`; all 26 `dep_update` at `low`                               |
| 6   | A transient registry fetch failure wrote `latest_version: NULL, is_deprecated: false` over known-good values on conflict (upsert SET clause ran unconditionally)                                       | n/a (latent erosion)                                                                 |

The audit also flagged (decision point, not acted on): `utils/lock-parse.ts`

- `ingestor/lock-parsers/*` form a second, fully-written lock-parser registry
  (~1,200 lines incl. a pnpm stub) with no non-test consumers — the live path
  is `ingestor/lock-parse.ts`'s own `LOCK_PARSERS` map. Wire it into
  `factory.ts` or remove it; do not leave both.

## Decision

Six fixes, one per finding:

1. **EPSS enrichment (`ingestor/epss.ts`, new).** After the OSV detail
   fetches, `OsvFetcher` harvests CVE IDs from each advisory's
   `rawData.aliases`, batch-queries FIRST's free EPSS API (100 CVEs per
   comma-separated request, bounded concurrency 5, one shared retry), and
   stamps `epssScore` onto the advisory rows before the writer's upsert.
   Non-fatal by design: transport/parse failures warn and leave the score
   unset (ADR 0039's failure handling). The upsert's `epss_score` SET is
   `COALESCE(excluded.epss_score, advisories.epss_score)` so a failed EPSS
   fetch can't erase a stored score. New `scripts/backfill-epss.mjs` is the
   idempotent one-time backfill (only `epss_score IS NULL` rows are
   touched). `OsvFetcher` grew optional constructor params
   (`epssFetcher`, `epssEnabled = true`) — the flag is the single rollback
   point.

2. **Version-filtered OSV queries.** `fetchAdvisories` now sends
   `version: <resolved_version>` in each batch query when the dependency
   has a lock-file-resolved version (ADR 0038's merge already populates
   it). OSV then returns only advisories affecting the installed version.
   `OsvFetchResult.versionMatchedPackages` reports which packages were
   version-matched; the writer labels those links `match_method:
"version_resolved"` (others keep the conservative `version_spec`). A
   name-only query remains the fallback for lock-less repos. Data-model
   doc updated: the enum value is `version_resolved`, not the phantom
   `resolved_version` it previously claimed.

3. **Stale-running recovery.** `resolvePending()` additionally re-picks
   repos at `running` whose `updated_at` is older than
   `STALE_RUNNING_HOURS` (default 2h; hours not minutes so a genuinely
   in-flight repo is never mistaken for dead). Logged visibly when it
   fires.

4. **CVSS v4.0 support (`ingestor/cvss.ts`).** Full port of FIRST's
   cvss-v4-calculator (BSD-2-Clause): the 64-entry macrovector score table,
   max-composed fragments, max-severity depths, and the mean-distance
   refinement — with threat (E), environmental (CR/IR/AR, M\* overrides,
   MSI/MSA:S safety), and supplemental metrics parsed exactly as the
   reference does. Validation is strict-fail-safe: missing base metric,
   unknown metric, or illegal value → `null`, never a partial guess.
   `extractSeverity`/`extractCvssScore` now prefer `CVSS_V4` → v3 → v2 →
   `database_specific.severity`.

5. **`dep_update` joins the effort-signal prefetch.** Changelog /
   migration-guide signals are equally relevant to a plain bump. Both the
   prefetch and the in-transaction lookup now cover `vulnerability_fix` +
   `dep_update`, deriving the target version identically (advisory fix →
   classification target → latest) so the two key lookups cannot drift.

6. **Registry-erosion guard.** `upsertDependencies` splits rows into
   with-metadata / without-metadata groups and issues two upserts: the
   latter's SET clause touches only manifest-derived columns
   (`version_spec`, `resolved_version`) and **preserves**
   `latest_version` / `is_deprecated` / `deprecation_note`. A metadata
   entry whose `latestVersion` is null still overwrites — that's the
   registry genuinely answering "no version field," real checked data.

## Alternatives considered

- **EPSS per-advisory during detail fetch** — N extra HTTP requests;
  batched post-detail is what ADR 0039 already specified.
- **Client-side range matching for `isAffected`** — needs a semver/PEP 440
  evaluation engine per ecosystem; OSV's server-side `version` filter does
  it correctly per-ecosystem for free. Revisit only if OSV's semantics
  ever diverge from what the mission board needs.
- **Sweeping stale-`running` rows to `failed` in SQL** — a status rewrite
  would race a genuinely-running job; re-picking on the read side is
  race-free by construction.
- **CVSS v4 → reuse the v3 formula** — not equivalent; v4's macrovector
  refinement is a different algorithm (differentially verified, see below).

## Consequences

- `impact_inputs.epss_score` becomes real data for CVE-aliased advisories
  (transparency preserved: the used value is stored on every score).
- Patched installs stop generating missions for advisories they were never
  exposed to; `match_method` honestly distinguishes the two provenances.
- Dead workflow runs self-heal within one cron cycle instead of wedging a
  repo at `running` forever.
- PYSEC/other CVSS-v4 advisories score from their actual vector instead of
  the `unknown` floor.
- `dep_update` missions can reach `medium` confidence; `high` remains
  unreachable while `LIBRARIES_IO_API_KEY` is unset (documented, ADR 0032).
- A registry outage degrades to stale metadata instead of erasing it.

## Live verification

- **CVSS v4 port:** differential harness ran FIRST's own cvss-v4-calculator
  as ground truth — 18/18 vectors agree (production PYSEC vectors, threat,
  environmental incl. MSI:S/MSA:S, no-impact shortcut, supplemental
  neutrality), cross-checked 18/18 against the official Python `cvss`
  library. Invalid-vector rejection table verified (missing metric, unknown
  metric, `SI:S`, `CVSS:4.1` prefix).
- **EPSS pipeline:** dry-run of `scripts/backfill-epss.mjs` against dev
  Neon + the real FIRST API (209 NULL rows → 143 scores retrieved), then
  applied: dev 199/209 populated. Production backfilled via the same
  scores: **167/172** with `epss_score` populated, 4 rows > 0.5. The 5
  remaining NULLs are structural: 4 advisories carry no CVE alias, 1 CVE
  (CVE-2013-7035) predates EPSS data. `COALESCE(excluded.epss_score,
advisories.epss_score)` verified against live Postgres in a rolled-back
  transaction (NULL preserves, non-null overwrites).
- **Tests:** 544/544 `packages/core` ingestor+scorer, 38/38 `scripts`,
  108 EPSS+OSV suites green at commit time; full §6 gate run in the same
  PR.
