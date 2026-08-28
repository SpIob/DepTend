# ADR 0039 — EPSS Exploitability Scoring Integration

**Status:** Accepted
**Date:** 2026-08-28
**Phase:** Scoring improvements

---

## Context

The mission scoring algorithm (ADR 0006, scoring_version 1.0.0) computes impact primarily from CVSS severity and dependency type. However, CVSS measures _vulnerability severity_ (how bad _could_ it be), not _exploitability_ (how likely is it to be exploited in the wild). Two vulnerabilities with identical CVSS scores can have vastly different real-world risk profiles.

EPSS (Exploit Prediction Scoring System) from FIRST.org provides a free, no-auth-required API that estimates the probability (0–1) that a given CVE will be exploited in the wild within 30 days. This is exactly the missing signal for impact scoring.

OSV advisory records already include CVE aliases (e.g., `["CVE-2021-44228", "GHSA-jfh8-c2jp-5v3q"]`), so EPSS can be looked up for any advisory that has a CVE identifier.

---

## Decision

Integrate EPSS into the mission scoring pipeline:

1. **Data fetching**: After OSV detail fetches complete, batch-query the EPSS API (`https://api.first.org/data/v1/epss?cve=CVE-XXXX-XXXX&cve=...`) for all unique CVE IDs found in the fetched advisories' `aliases` arrays. The EPSS API supports multiple `cve=` parameters in a single request (batched up to 100 CVEs per request).

2. **Storage**: Add `epss_score` column (`numeric(6,5)`, nullable) to the `advisories` table. Store the raw EPSS probability (e.g., `0.97385`). Also propagate to `ImpactInputs.epss_score` in `mission_scores.impact_inputs` for auditability.

3. **Scoring**: In `DefaultImpactScorer`, when `epss_score` is present, boost the base impact by a factor of `(1 + epss_score * EPSS_BOOST_FACTOR)`, where `EPSS_BOOST_FACTOR = 0.5`. This means:
   - EPSS 0.0 (no exploitability signal) → no change
   - EPSS 0.5 (moderate exploitability) → 1.25× boost
   - EPSS 1.0 (near-certain exploitation) → 1.5× boost
     The result is still clamped to the 0–10 range.

4. **Versioning**: Bump `scoring_version` to `1.1.0`.

5. **Failure handling**: EPSS fetch failures are non-fatal — warn and continue without EPSS data for the affected CVEs. The API is free and public; no auth or rate limits beyond normal HTTP courtesy.

---

## Alternatives Considered

| Option                                      | Notes                                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Use EPSS percentile instead of raw score    | Percentile is relative to all CVEs; raw probability is more directly interpretable for scoring.                 |
| Make EPSS a separate scoring component      | Would require new weight tuning; boost factor on existing impact is simpler and preserves v1.0.0 weight ratios. |
| Require EPSS for all advisories             | Not feasible — many OSV entries lack CVE aliases (GHSA-only), and EPSS only covers CVEs.                        |
| Fetch EPSS per-advisory during detail fetch | Would add N extra HTTP requests; batching after detail fetches is far more efficient.                           |

---

## Consequences

- **Schema migration required**: `advisories.epss_score` column (numeric(6,5), nullable).
- **Scoring algorithm change**: Missions with high-EPSS advisories will score higher impact. This is intentional — a critical CVSS with high exploitability _should_ outrank a critical CVSS with no known exploitation.
- **Transparency**: `epss_score` is stored in `impact_inputs` on every mission score, so users can see exactly what EPSS value was used.
- **No new costs**: EPSS API is free, public, no auth required.
- **Backward compatibility**: Advisories without CVE aliases (or where EPSS fetch failed) simply have `epss_score: null` and score identically to v1.0.0.

---

## Free-tier compliance

EPSS API (https://api.first.org/data/v1/epss) is completely free, requires no API key, no registration, and has no published rate limits beyond standard HTTP abuse prevention. Fully compliant with zero-budget constraint.

---

## Implementation Notes

- Modified files:
  - `packages/core/src/db/schema.ts` — added `epssScore` column to `advisories`
  - `packages/core/src/db/json-types.ts` — added `epss_score` to `ImpactInputs`
  - `packages/core/src/ingestor/osv.ts` — added `fetchEpssScores()` batch fetch after detail fetches
  - `packages/core/src/scorer/impact.ts` — added `EPSS_BOOST_FACTOR` and integration in `DefaultImpactScorer`
  - `packages/core/src/scorer/mission-scorer.ts` — pass `epss_score` through `buildImpactInputs`
  - `docs/adr/0039-epss-integration.md` — this ADR

- Migration: `drizzle-kit generate` will produce a migration adding the `epss_score` column to `advisories`. Apply with `drizzle-kit migrate` against the unpooled `DATABASE_URL_UNPOOLED`.
