# ADR 0010 — Fix: OSV `querybatch` Returns Minimal Data; Fetch Full Details Per Advisory

**Status:** Accepted
**Date:** 2026-07-07
**Phase:** 2 (fix applies to Phase 1 code — `OsvFetcher` was written in Phase 1)

---

## Context

Live smoke-testing against `deptend-test-fixture` (`minimist@0.0.8`, `lodash@4.17.4` — both with long-published, well-documented CVSS scores and fixed versions) produced 12 missions where **every single one** showed `severity: unknown`, `fixed_version: null`, and a description whose first line read literally `"Advisory GHSA-xxxx-..."` instead of real advisory text.

That last symptom was the giveaway: `mapVulnToAdvisory()` only falls back to `` `Advisory ${vuln.id}` `` when `vuln.summary` is empty (`osv.ts`, "Use ternaries ... so an empty-string summary/details also falls through to the default"). Seeing that fallback on **100% of real advisories** — including ones GitHub's own advisory pages show summaries for — meant every optional field was arriving empty, not that OSV genuinely lacked the data for 12 different well-known CVEs.

**Root cause: `OsvFetcher.fetchAdvisories()` calls `POST https://api.osv.dev/v1/querybatch`, and per OSV's own documented API contract, that endpoint returns only `{id, modified}` per result — never `severity`, `affected`, `summary`, `details`, or `database_specific`.** Getting the full record requires a follow-up `GET /v1/vulns/{id}` per advisory. `mapVulnToAdvisory()`'s parsing logic itself is correct — `extractSeverity`, `extractCvssScore`, `extractAffectedRanges`, `extractFixedVersion` all handle a full OSV vulnerability object properly. It was just never given one.

**How this got past 44 passing unit tests:** `osv.test.ts`'s single `mockOsvResponse()` helper stubbed `fetch` to return the _full_ `makeVuln()` object directly as the batch response — a mock that doesn't reflect OSV's real, documented, minimal-batch-response contract. This is the second time in this project a mocked test gave false confidence against a real third-party API's actual behavior (the first being `db.transaction()` against `neon-http`, ADR 0009) — worth treating as a pattern, not a coincidence: **a mock needs to model the actual documented contract of the thing it's replacing, not an idealized version of it.**

## Decision

Add a follow-up detail fetch, `GET https://api.osv.dev/v1/vulns/{id}`, for every **unique** advisory ID returned by the batch query (deduplicated first — the same advisory can affect multiple packages, and should only be fetched once). Bounded concurrency, mirroring the existing pattern in `registry.ts` (worker-pool style, default limit 10) rather than firing one request per advisory unboundedly.

**A single advisory's detail fetch failing does not fail the whole ingestion run.** Network error, non-200, or bad JSON on one `GET /v1/vulns/{id}` call logs a warning and drops that one advisory from the results (both `advisories` and `packageAdvisoryMap`) — the other 11 advisories in a 12-advisory batch still get written correctly. This mirrors the project's existing "surface data-quality problems visibly, don't let one bad input take down the whole run" pattern already used elsewhere (e.g. `registry.ts`'s per-package fetch failures).

**`mapVulnToAdvisory` and `extractSeverity` keep their `packageName` parameter, but it's now threaded through differently.** `advisories.packageName` is `NOT NULL`, and — as the original code already implicitly assumed — a single advisory can affect more than one package (see the existing "deduplicates advisories that affect multiple packages" test). The original code attributed each advisory to whichever package it was _first encountered under_ while iterating the batch response, simply because that's the package in scope at the point the advisory was first seen and mapped. Since detail-fetching now happens independently of any one package (once per unique advisory ID, not once per package), that attribution has to be computed explicitly rather than falling out of the loop structure — `fetchAdvisories` now builds a `firstPackageForId` map alongside `packageAdvisoryMap` for exactly this purpose, preserving the original convention rather than changing it. Worth being clear that "first package encountered" was always a somewhat arbitrary convention (order depends on `package.json` parse order) — that's a pre-existing characteristic of the schema (one `packageName` column on an advisory that can affect several packages) which this fix preserves rather than relitigates. The complete, accurate package↔advisory relationship is what `dependency_advisories` is for.

**Side benefit:** `rawData` now stores the actual full OSV record verbatim, as the original module header already claimed it did ("Raw OSV response stored verbatim in advisory.rawData for full auditability") — previously it was storing the minimal `{id, modified}` batch entry, which wasn't really useful for the auditability the comment promised.

## Consequences

- `packages/core/src/ingestor/osv.ts`: `fetchAdvisories()` restructured into batch-query (unchanged) → collect unique IDs → bounded-concurrency detail fetch → map full records. New private `fetchFullDetails()` and `fetchVulnById()` methods. Constructor gains two optional parameters (`vulnUrlBase`, `concurrency`) with defaults — backward compatible, `new OsvFetcher()` with no args still works exactly as `scripts/ingest.js` already calls it.
- `packages/core/src/ingestor/osv.test.ts`: rewritten to mock both endpoints distinctly (batch → minimal, detail → full), matching the real contract. New tests cover: a single failed detail fetch not failing the whole run, and that failed advisories are dropped from `packageAdvisoryMap` too.
- **Every ingestion run now makes 1 (batch) + N (unique advisories) OSV requests instead of 1.** For a 3-repo MVP cap with realistically modest advisory counts per repo, this is still comfortably within OSV's free, unauthenticated, undocumented-but-generous rate tolerance — no auth, no cost, no new service. Worth revisiting only if a repo's advisory count grows unusually large.
- This is a Phase 1 bug fix landing during Phase 2, not a new Phase 2 decision — no scoring formulas or mission logic change. Every mission generated before this fix should be treated as having degraded impact/effort signal (severity floored at "unknown", `fixed_version` universally null) and will self-correct once this fix runs and ingestion is re-triggered.

## Free-tier compliance

Same free, unauthenticated OSV API. No new dependency, no new service.
