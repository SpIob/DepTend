/**
 * OSV Advisory Fetcher
 *
 * Queries the OSV batch API (https://osv.dev/docs/#tag/api/operation/OSV_QueryAffectedBatch)
 * to find which advisory IDs affect each dependency, then fetches the full
 * record for each unique advisory via the single-vulnerability endpoint
 * (https://osv.dev/docs/#tag/api/operation/OSV_GetVulnById) and maps each to
 * a NewAdvisory insert shape ready for the DB write layer.
 *
 * Design decisions:
 *   - The batch endpoint (`querybatch`) returns only {id, modified} per
 *     result — never severity, affected ranges, summary, or details. This
 *     is OSV's documented contract, not a partial/flaky response. A
 *     follow-up GET /v1/vulns/{id} is required for the full record (ADR
 *     0010 — this was a real bug in the original Phase 1 implementation,
 *     which treated the batch result as if it were already the full record).
 *   - Detail fetches are deduplicated by advisory ID first (the same
 *     advisory can affect multiple packages) and run with bounded
 *     concurrency (default 10), mirroring registry.ts's pattern.
 *   - A single advisory's detail fetch failing does not fail the whole run
 *     — it's warned about and dropped from both the advisories map and
 *     packageAdvisoryMap; every other advisory in the batch still writes.
 *   - No auth required — OSV is a fully public API.
 *   - Raw OSV response (the full record, not the minimal batch entry)
 *     stored verbatim in advisory.rawData for full auditability and future
 *     re-processing without re-fetching.
 *   - Severity mapped from CVSS v3 score using NIST thresholds where CVSS
 *     is available (the numeric score is computed from vector strings per
 *     the CVSS spec — many records carry only the vector); falls back to
 *     OSV's own severity enum; defaults to "unknown" when neither is
 *     present.
 *   - fixed_version extracted from the first "fixed" event in a range OSV
 *     considers authoritative for the queried ecosystem's own versioning
 *     scheme: SEMVER-type ranges for npm, and — since PyPI isn't
 *     semver-versioned — ECOSYSTEM-type ranges too when the ecosystem is
 *     pypi (OSV's schema evaluates ECOSYSTEM-type ranges using each
 *     ecosystem's native comparator; PEP 440 for PyPI). GIT-type ranges are
 *     never used for either ecosystem — they're real but not useful for
 *     the version-based matching this project does (ADR 0022).
 *
 * Phase 1 scope — intentionally out of scope:
 *   - GHSA advisory source (added when GitHub REST API integration lands)
 *   - Version range matching against resolved versions (requires lock file)
 *   - Transitive dependency advisories
 *
 * ADR: docs/adr/0003-npm-ecosystem-first.md (ecosystem choice)
 *      docs/adr/0010-osv-fetcher-detail-fetch-fix.md (batch/detail split)
 *      docs/adr/0022-phase6-pypi-ecosystem.md (ecosystem parametrization,
 *      ECOSYSTEM-type range handling for PyPI)
 */

import type { NewAdvisory, Severity, Ecosystem } from "../db/schema.js";
import type { OsvVersionRange } from "../db/json-types.js";
import type { ParsedDependency } from "../ingestor/interface.js";
import { DEFAULT_RETRY_DELAY_MS } from "./fetch-retry.js";
import { fetchJson } from "./fetch-json.js";
import { runBounded } from "./concurrency.js";

// ---------------------------------------------------------------------------
// OSV API constants
// ---------------------------------------------------------------------------

const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const OSV_VULN_BASE_URL = "https://api.osv.dev/v1/vulns";

/** OSV enforces a 1,000-package limit per batch request. */
const OSV_BATCH_LIMIT = 1000;

/** Default number of in-flight GET /v1/vulns/{id} requests at once. */
const DEFAULT_DETAIL_CONCURRENCY = 10;

/**
 * Our internal Ecosystem enum values ("npm", "pypi") vs. OSV's own
 * ecosystem identifier strings are two different namespaces that happen to
 * partially overlap — "npm" reads the same in both, but PyPI's OSV
 * identifier is "PyPI" (exact casing, confirmed against osv-schema's own
 * validation pattern; getting this wrong wouldn't error, it would just
 * silently return zero results — the same class of bug ADR 0010 caught).
 * A Record<Ecosystem, string> here means adding a third ecosystem without
 * updating this map is a compile error, not a silent gap.
 */
const OSV_ECOSYSTEM_NAMES: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
  go: "Go",
};

/**
 * Which OSV range type(s) extractAffectedRanges() accepts, per ecosystem —
 * see that method's docstring for the reasoning behind each entry. Same
 * Record<Ecosystem, ...> exhaustiveness guarantee as OSV_ECOSYSTEM_NAMES
 * above.
 */
const ACCEPTED_RANGE_TYPES: Record<Ecosystem, OsvRange["type"][]> = {
  npm: ["SEMVER"],
  pypi: ["SEMVER", "ECOSYSTEM"],
  go: ["SEMVER"],
};

// ---------------------------------------------------------------------------
// Raw OSV API response types
// ---------------------------------------------------------------------------

interface OsvQuery {
  package: { name: string; ecosystem: string };
}

interface OsvBatchRequest {
  queries: OsvQuery[];
}

/** What the batch endpoint actually returns per result — id + modified only. */
interface OsvMinimalVuln {
  id: string;
  modified?: string;
}

interface OsvBatchQueryResult {
  vulns?: OsvMinimalVuln[];
}

interface OsvBatchResponse {
  results: OsvBatchQueryResult[];
}

interface OsvSeverity {
  type: string; // typically "CVSS_V2" or "CVSS_V3"
  score: string; // e.g. "CVSS:3.1/AV:N/AC:L/..."
}

interface OsvRange {
  type: "SEMVER" | "ECOSYSTEM" | "GIT";
  events: { introduced?: string; fixed?: string; last_affected?: string }[];
}

interface OsvAffected {
  package?: { name: string; ecosystem: string };
  ranges?: OsvRange[];
  versions?: string[];
  database_specific?: Record<string, unknown>;
  ecosystem_specific?: Record<string, unknown>;
}

/** The full record returned by GET /v1/vulns/{id} — everything is optional
 * except id, since OSV/GHSA entries don't uniformly populate every field. */
interface OsvVulnerability {
  id: string;
  modified: string;
  published?: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: OsvSeverity[];
  affected?: OsvAffected[];
  database_specific?: Record<string, unknown>;
  references?: { type: string; url: string }[];
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface OsvFetchResult {
  /** Advisory rows ready for DB upsert, keyed by osv_id */
  advisories: Map<string, NewAdvisory>;
  /**
   * Maps each package name to the osv_ids that affect it.
   * Used by the DB write layer to populate dependency_advisories.
   */
  packageAdvisoryMap: Map<string, string[]>;
  /** Data-quality warnings to surface in the UI */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// OsvFetcher
// ---------------------------------------------------------------------------

export class OsvFetcher {
  private readonly batchUrl: string;
  private readonly vulnUrlBase: string;
  private readonly concurrency: number;
  private readonly retryDelayMs: number;

  constructor(
    batchUrl = OSV_BATCH_URL,
    vulnUrlBase = OSV_VULN_BASE_URL,
    concurrency = DEFAULT_DETAIL_CONCURRENCY,
    // Flat backoff for the single transient-failure retry (fetch-retry.ts).
    // Tests pass 0; production keeps the default.
    retryDelayMs: number = DEFAULT_RETRY_DELAY_MS,
  ) {
    // Injected in tests to point at a mock server
    this.batchUrl = batchUrl;
    this.vulnUrlBase = vulnUrlBase;
    this.concurrency = concurrency;
    this.retryDelayMs = retryDelayMs;
  }

  /**
   * Fetch advisories for all provided dependencies.
   *
   * Two network stages: one batch query to find which advisory IDs affect
   * which packages, then one detail fetch per unique advisory ID to get the
   * full record (severity, affected ranges, summary — see ADR 0010 for why
   * the batch response alone isn't enough).
   *
   * Deduplicates packages before the batch query, and deduplicates advisory
   * IDs before the detail fetch — the same package appearing as both a
   * production and dev dependency only needs one query, and the same
   * advisory affecting multiple packages only needs one detail fetch.
   *
   * @param dependencies - Parsed dependencies from an EcosystemIngestor
   * @param ecosystem - single value for the whole call, not per-dependency
   *   — a direct consequence of ADR 0022's ecosystem-detection design
   *   (exactly one ingestor "wins" per repo, so every dependency in one
   *   ingestion run already shares the same ecosystem). Defaults to "npm"
   *   so existing callers (scripts/ingest.js, cli/analyze.ts) keep working
   *   unchanged until Step 7 wires the ecosystem-detection router through
   *   them and starts passing the real detected value explicitly — both
   *   only ever process npm repos today, so the default is accurate, not
   *   just backward-compatible.
   * @returns OsvFetchResult with advisory insert rows and the package→advisory map
   */
  async fetchAdvisories(
    dependencies: ParsedDependency[],
    ecosystem: Ecosystem = "npm",
  ): Promise<OsvFetchResult> {
    const warnings: string[] = [];

    if (dependencies.length === 0) {
      return { advisories: new Map(), packageAdvisoryMap: new Map(), warnings };
    }

    // Deduplicate — multiple dep_type rows for the same package_name share
    // the same set of advisories.
    const uniquePackages = [...new Set(dependencies.map((d) => d.package_name))];

    if (uniquePackages.length > OSV_BATCH_LIMIT) {
      warnings.push(
        `Repo has ${String(uniquePackages.length)} unique packages, exceeding the OSV ` +
          `batch limit of ${String(OSV_BATCH_LIMIT)}. Only the first ${String(OSV_BATCH_LIMIT)} will be queried.`,
      );
    }

    const queried = uniquePackages.slice(0, OSV_BATCH_LIMIT);

    // ------------------------------------------------------------------
    // Stage 1: batch query — returns only {id, modified} per result
    // ------------------------------------------------------------------
    const osvEcosystemName = OSV_ECOSYSTEM_NAMES[ecosystem];
    const requestBody: OsvBatchRequest = {
      queries: queried.map((name) => ({
        package: { name, ecosystem: osvEcosystemName },
      })),
    };

    const batchResponse = await fetchJson<OsvBatchResponse>(
      this.batchUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
      {
        fetchOptions: { retryDelayMs: this.retryDelayMs },
        errorPrefix: "OSV batch API",
      },
    );

    if (!Array.isArray(batchResponse.results)) {
      throw new Error("OSV batch API response missing expected 'results' array.");
    }

    // ------------------------------------------------------------------
    // Build package -> [ids] from the (minimal) batch response, and
    // collect the set of unique ids needing a full-detail fetch. Also
    // track the first package each id was seen under — advisories.
    // packageName is NOT NULL, and an advisory can affect more than one
    // package (see "deduplicates advisories that affect multiple packages"
    // below), so this preserves the original code's convention of
    // attributing the row to whichever package it was first encountered
    // under, now that fetching happens independently of any one package.
    // ------------------------------------------------------------------
    const packageAdvisoryMap = new Map<string, string[]>();
    const uniqueIds = new Set<string>();
    const firstPackageForId = new Map<string, string>();

    for (let i = 0; i < queried.length; i++) {
      const packageName = queried[i];
      if (packageName === undefined) continue;

      const result = batchResponse.results[i];
      const minimalVulns = result?.vulns ?? [];

      const idsForPackage: string[] = [];

      for (const vuln of minimalVulns) {
        if (!vuln.id) {
          warnings.push(
            `OSV returned a vulnerability with no id for package "${packageName}" — skipped.`,
          );
          continue;
        }
        idsForPackage.push(vuln.id);
        uniqueIds.add(vuln.id);
        if (!firstPackageForId.has(vuln.id)) {
          firstPackageForId.set(vuln.id, packageName);
        }
      }

      if (idsForPackage.length > 0) {
        packageAdvisoryMap.set(packageName, idsForPackage);
      }
    }

    // ------------------------------------------------------------------
    // Stage 2: fetch full details per unique advisory id
    // ------------------------------------------------------------------
    const { advisories, failedIds } = await this.fetchFullDetails(
      [...uniqueIds],
      firstPackageForId,
      ecosystem,
      warnings,
    );

    // Drop any advisory whose detail fetch failed from the package map too
    // — we can't write a valid row for it, so it shouldn't be referenced.
    if (failedIds.size > 0) {
      for (const [packageName, ids] of packageAdvisoryMap) {
        const remaining = ids.filter((id) => !failedIds.has(id));
        if (remaining.length === 0) {
          packageAdvisoryMap.delete(packageName);
        } else {
          packageAdvisoryMap.set(packageName, remaining);
        }
      }
    }

    return { advisories, packageAdvisoryMap, warnings };
  }

  // ---------------------------------------------------------------------------
  // Private helpers — detail fetch
  // ---------------------------------------------------------------------------

  /**
   * Fetch the full record for each unique advisory id, with at most
   * `this.concurrency` requests in flight at once. A single failed fetch is
   * warned about and excluded from the result — it does not throw or stop
   * the other ids from being processed.
   *
   * Uses a semaphore pattern with Promise.allSettled for better throughput
   * than the worker-pool approach: faster requests free up concurrency slots
   * immediately rather than waiting for slower ones in the same worker.
   */
  private async fetchFullDetails(
    ids: string[],
    firstPackageForId: Map<string, string>,
    ecosystem: Ecosystem,
    warnings: string[],
  ): Promise<{ advisories: Map<string, NewAdvisory>; failedIds: Set<string> }> {
    const advisories = new Map<string, NewAdvisory>();
    const failedIds = new Set<string>();

    // Bounded-concurrency worker pool (see concurrency.ts). Per-item
    // failures (network, HTTP, parse) are caught and recorded as warnings
    // so a single bad advisory id doesn't fail the whole batch — every
    // other id in the batch still lands.
    const results = await runBounded(ids, this.concurrency, async (id) => {
      try {
        const vuln = await this.fetchVulnById(id);
        const packageName = firstPackageForId.get(id) ?? "";
        return {
          kind: "ok" as const,
          id,
          advisory: this.mapVulnToAdvisory(vuln, packageName, ecosystem, warnings),
        };
      } catch (err) {
        return {
          kind: "fail" as const,
          id,
          error:
            `Failed to fetch full details for advisory ${id}: ${String(err)}. ` +
            `Skipped — this advisory will not appear in results this run.`,
        };
      }
    });

    for (const result of results) {
      if (result.kind === "ok") {
        advisories.set(result.id, result.advisory);
      } else {
        failedIds.add(result.id);
        warnings.push(result.error);
      }
    }

    return { advisories, failedIds };
  }

  private async fetchVulnById(id: string): Promise<OsvVulnerability> {
    return fetchJson<OsvVulnerability>(`${this.vulnUrlBase}/${encodeURIComponent(id)}`, undefined, {
      fetchOptions: { retryDelayMs: this.retryDelayMs },
      errorPrefix: "OSV vuln detail",
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers — mapping a full record to a NewAdvisory
  // ---------------------------------------------------------------------------

  /**
   * Map a single full OSV vulnerability record to a NewAdvisory insert
   * shape. The raw OSV object is stored verbatim in rawData.
   *
   * packageName is the first package this advisory id was encountered
   * under in the batch response (see fetchAdvisories) — preserved from
   * the original Phase 1 convention. advisories.packageName is NOT NULL,
   * and the full picture of every package an advisory affects lives in
   * dependency_advisories, not on this single column.
   */
  private mapVulnToAdvisory(
    vuln: OsvVulnerability,
    packageName: string,
    ecosystem: Ecosystem,
    warnings: string[],
  ): NewAdvisory {
    const severity = this.extractSeverity(vuln, warnings);
    const cvssScore = this.extractCvssScore(vuln);
    const affectedVersions = this.extractAffectedRanges(vuln, ecosystem, packageName);
    const fixedVersion = this.extractFixedVersion(affectedVersions);

    // Determine advisory source: GHSA IDs are prefixed with "GHSA-"
    const source = vuln.id.startsWith("GHSA-") ? "ghsa" : "osv";

    // Use ternaries (not || or ??) so an empty-string summary/details also
    // falls through to the default — ?? would only catch null/undefined.
    const trimmedSummary = vuln.summary?.trim();
    const summary =
      trimmedSummary !== undefined && trimmedSummary.length > 0
        ? trimmedSummary
        : `Advisory ${vuln.id}`;

    const trimmedDetails = vuln.details?.trim();
    const details =
      trimmedDetails !== undefined && trimmedDetails.length > 0 ? trimmedDetails : null;

    return {
      osvId: vuln.id,
      source,
      // Our own internal enum value ("npm"/"pypi"), not OSV's ecosystem
      // string ("npm"/"PyPI") — two different namespaces, see
      // OSV_ECOSYSTEM_NAMES above.
      ecosystem,
      packageName,
      severity,
      cvssScore,
      summary,
      details,
      affectedVersions,
      fixedVersion,
      publishedAt: vuln.published ? new Date(vuln.published) : null,
      modifiedAt: vuln.modified ? new Date(vuln.modified) : null,
      rawData: vuln,
    };
  }

  /**
   * Derive severity from CVSS v3 score (preferred) → CVSS v2 → OSV's own
   * database_specific.severity field → "unknown".
   *
   * NIST CVSS v3 thresholds:
   *   Critical ≥ 9.0 | High ≥ 7.0 | Medium ≥ 4.0 | Low ≥ 0.1 | None = 0.0
   */
  private extractSeverity(vuln: OsvVulnerability, warnings: string[]): Severity {
    // 1. Try CVSS v3 numeric score
    const cvss3 = vuln.severity?.find((s) => s.type === "CVSS_V3");
    if (cvss3) {
      const score = this.parseCvssNumericScore(cvss3.score);
      if (score !== null) return cvssScoreToSeverity(score);
    }

    // 2. Try CVSS v2 numeric score
    const cvss2 = vuln.severity?.find((s) => s.type === "CVSS_V2");
    if (cvss2) {
      const score = this.parseCvssNumericScore(cvss2.score);
      if (score !== null) return cvssScoreToSeverity(score);
    }

    // 3. Try database_specific.severity string (e.g. GitHub Advisory DB)
    const dbSeverity = vuln.database_specific?.severity;
    if (typeof dbSeverity === "string") {
      const mapped = mapStringSeverity(dbSeverity);
      if (mapped !== null) return mapped;
    }

    warnings.push(
      `No CVSS score or severity level found for advisory ${vuln.id}. Severity recorded as "unknown".`,
    );
    return "unknown";
  }

  /**
   * Extract the numeric CVSS base score for storage.
   * Handles both full vector strings (e.g. "CVSS:3.1/AV:N/AC:L/...") and
   * bare numeric strings (e.g. "7.5").
   * Returns null when no parseable CVSS score exists.
   */
  private extractCvssScore(vuln: OsvVulnerability): number | null {
    for (const sev of vuln.severity ?? []) {
      if (sev.type === "CVSS_V3" || sev.type === "CVSS_V2") {
        const score = this.parseCvssNumericScore(sev.score);
        if (score !== null) return score;
      }
    }
    return null;
  }

  /**
   * Parse a numeric CVSS base score from either a bare number or a vector
   * string.
   *
   * Bare numeric: "7.5" — common in GitHub Advisory data
   *   { type: "CVSS_V3", score: "9.8" }.
   * Vector string: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" — the
   * base score is COMPUTED from the vector's own metrics per the CVSS v3.1
   * (or v2) specification; it is not stored anywhere else in the record.
   * Returns null when neither form parses.
   */
  private parseCvssNumericScore(raw: string): number | null {
    // Bare numeric: "7.5"
    const bare = parseFloat(raw);
    if (!isNaN(bare) && bare >= 0 && bare <= 10) return bare;

    // Vector string — compute the base score from its metrics
    return cvssVectorToBaseScore(raw);
  }

  /**
   * Extract affected ranges from the OSV vulnerability, filtered to (a) the
   * queried package's own "affected" entry and (b) the range type(s) that
   * are actually usable for the queried ecosystem's own version scheme.
   *
   * CONFIRMED LIVE BUG (found during ADR 0024's Step 6 fixture testing, not
   * hypothetical): a single OSV vulnerability record can legitimately list
   * MULTIPLE, unrelated packages in its "affected" array. Real example:
   * CVE-2020-7919 / GO-2022-0229 covers both the Go toolchain/stdlib
   * (crypto/x509) AND golang.org/x/crypto/cryptobyte as two separate
   * sibling entries in one record — the toolchain entry's fix is "1.12.16"
   * (a Go *release* number), x/crypto's own fix is the unrelated pseudo-
   * version "v0.0.0-20200124225646-8b5121be2f68". Before this fix, this
   * method iterated every "affected" entry unconditionally and merged all
   * of their ranges together — so querying for golang.org/x/crypto could
   * silently surface the *stdlib* entry's "1.12.16" as if it were an
   * x/crypto version, a nonsensical, actively-misleading recommendation.
   * Confirmed via the real fixture's CLI output, then confirmed against
   * the authoritative source (vuln.go.dev/ID/GO-2022-0229.json shows two
   * separate "affected" entries), not guessed at.
   *
   * This shape was never exercised before Go: npm/PyPI advisories, in
   * practice, essentially always carry exactly one "affected" entry
   * matching the queried package — GHSA-sourced records rarely bundle
   * multiple unrelated packages the way a Go toolchain+module advisory
   * naturally does. The bug was latent, not Go-specific in principle, just
   * Go-specific in what finally exercised it live.
   *
   * An "affected" entry with no `package` field at all (only ever happens
   * in this project's own test fixtures, never in real OSV responses) is
   * treated as unfiltered/always-included — real API data always
   * populates `package`, so this only affects test ergonomics, not
   * production correctness.
   *
   * GIT ranges are never used for any ecosystem — real, but not useful for
   * the version-based matching this project does.
   *
   * npm is semver-versioned, so OSV represents its ranges as SEMVER type.
   * PyPI is PEP-440-versioned, not semver — OSV represents its ranges as
   * ECOSYSTEM type instead, evaluated against each ecosystem's own native
   * comparator (confirmed against multiple independent sources describing
   * osv-schema's Range_Type enum and OSV's own "ecosystem's native
   * versioning scheme" design; not confirmed by directly fetching a live
   * PyPI OSV record, since api.osv.dev isn't reachable from this
   * environment's network egress list — worth a real spot-check against
   * production data during Step 8's live verification). SEMVER is still
   * accepted for pypi too, in case a specific record happens to use it —
   * accepting a broader set for pypi costs nothing; narrowing npm's
   * existing, already-verified behavior is what would carry real risk.
   *
   * Go is real, toolchain-enforced SemVer, and — unlike PyPI — OSV's own
   * Go implementation is documented as populating SEMVER-type ranges only
   * (golang.org/x/vuln/internal/osv's own doc comment: "only the SEMVER
   * affected range type is implemented" for the Go database), so `go`
   * needs no ECOSYSTEM-type handling (ADR 0024, Decision 5).
   *
   * ACCEPTED_RANGE_TYPES is a Record<Ecosystem, ...>, not a ternary —
   * adding a future ecosystem here without an entry is a compile error,
   * not a silent fall-through to the wrong range types.
   */
  private extractAffectedRanges(
    vuln: OsvVulnerability,
    ecosystem: Ecosystem,
    packageName: string,
  ): OsvVersionRange[] {
    const acceptedTypes = ACCEPTED_RANGE_TYPES[ecosystem];
    const osvEcosystemName = OSV_ECOSYSTEM_NAMES[ecosystem];

    const ranges: OsvVersionRange[] = [];

    for (const affected of vuln.affected ?? []) {
      // Skip sibling entries for a *different* package within the same
      // vuln record — this is the actual fix (see docstring above). An
      // entry with no `package` field at all is never disqualified (real
      // OSV data always has one; this only matters for test fixtures that
      // omit it because the package identity isn't what they're testing).
      if (
        affected.package !== undefined &&
        (affected.package.name !== packageName || affected.package.ecosystem !== osvEcosystemName)
      ) {
        continue;
      }

      for (const range of affected.ranges ?? []) {
        if (acceptedTypes.includes(range.type)) {
          ranges.push({
            type: range.type,
            events: range.events,
          });
        }
      }
    }

    return ranges;
  }

  /**
   * Extract the fixed version from the first SEMVER range that has a
   * "fixed" event. Returns null when no fix exists (unfixed or 0-day).
   */
  private extractFixedVersion(ranges: OsvVersionRange[]): string | null {
    for (const range of ranges) {
      for (const event of range.events) {
        if (event.fixed !== undefined && event.fixed !== "") {
          return event.fixed;
        }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure utility functions (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Map a numeric CVSS score to a Severity enum value using NIST thresholds.
 * https://nvd.nist.gov/vuln-metrics/cvss
 */
export function cvssScoreToSeverity(score: number): Severity {
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  if (score > 0.0) return "low";
  return "unknown";
}

/**
 * Map a free-text severity string (from database_specific) to a Severity.
 * Returns null if the string is unrecognised.
 */
export function mapStringSeverity(raw: string): Severity | null {
  switch (raw.toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "moderate":
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// CVSS base-score computation from vector strings (pure, exported for unit
// testing)
//
// OSV severity entries frequently carry ONLY a vector string
// ("CVSS:3.1/AV:N/...") with no numeric score anywhere else in the record —
// parseCvssNumericScore() used to return null for those, silently under-
// reading both cvssScore and the derived severity. These functions compute
// the base score from the vector's own metrics per FIRST's specifications:
// v3.0/v3.1 share one base-score formula (they differ only in Roundup's
// floating-point handling; the v3.1 variant below is used for both), and
// CVSS v2 has its own smaller formula.
// ---------------------------------------------------------------------------

/** Metric weights per the CVSS v3.1 specification, §8.1/§8.2 tables. */
const CVSS_V3_AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const CVSS_V3_AC: Record<string, number> = { L: 0.77, H: 0.44 };
// PR differs by Scope — values cross-checked live against NVD-published
// scores for canonical vectors (PR:L/S:U → 8.8, PR:L/S:C → 9.9).
const CVSS_V3_PR_UNCHANGED: Record<string, number> = { N: 0.85, L: 0.62, H: 0.44 };
const CVSS_V3_PR_CHANGED: Record<string, number> = { N: 0.85, L: 0.68, H: 0.27 };
const CVSS_V3_UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CVSS_V3_CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

/** Metric weights per the CVSS v2 specification, §2.1 tables. */
const CVSS_V2_AV: Record<string, number> = { L: 0.395, A: 0.646, N: 1 };
const CVSS_V2_AC: Record<string, number> = { H: 0.35, M: 0.61, L: 0.71 };
const CVSS_V2_AU: Record<string, number> = { M: 0.45, S: 0.56, N: 0.704 };
const CVSS_V2_CIA: Record<string, number> = { N: 0, P: 0.275, C: 0.66 };

function cvssMetricWeight(
  weights: Record<string, number>,
  value: string | undefined,
): number | null {
  if (value === undefined) return null;
  return weights[value] ?? null;
}

/**
 * CVSS v3.1's official Roundup (spec appendix A) — rounds up to one decimal
 * without the floating-point edge cases of a plain Math.ceil(x * 10) / 10.
 */
function roundCvssUp(input: number): number {
  const intInput = Math.round(input * 100000);
  if (intInput % 10000 === 0) {
    return intInput / 100000;
  }
  return (Math.floor(intInput / 10000) + 1) / 10;
}

function cvssV3BaseScore(metrics: Map<string, string>): number | null {
  const av = cvssMetricWeight(CVSS_V3_AV, metrics.get("AV"));
  const ac = cvssMetricWeight(CVSS_V3_AC, metrics.get("AC"));
  const ui = cvssMetricWeight(CVSS_V3_UI, metrics.get("UI"));
  const c = cvssMetricWeight(CVSS_V3_CIA, metrics.get("C"));
  const i = cvssMetricWeight(CVSS_V3_CIA, metrics.get("I"));
  const a = cvssMetricWeight(CVSS_V3_CIA, metrics.get("A"));
  const scope = metrics.get("S");
  if (
    av === null ||
    ac === null ||
    ui === null ||
    c === null ||
    i === null ||
    a === null ||
    (scope !== "U" && scope !== "C")
  ) {
    return null; // incomplete or malformed vector — fail safe, don't guess
  }

  const pr = cvssMetricWeight(
    scope === "C" ? CVSS_V3_PR_CHANGED : CVSS_V3_PR_UNCHANGED,
    metrics.get("PR"),
  );
  if (pr === null) return null;

  const iscBase = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact =
    scope === "C" ? 7.52 * (iscBase - 0.029) - 3.25 * Math.pow(iscBase - 0.02, 15) : 6.42 * iscBase;
  if (impact <= 0) return 0;

  const exploitability = 8.22 * av * ac * pr * ui;
  const base =
    scope === "C"
      ? Math.min(1.08 * (impact + exploitability), 10)
      : Math.min(impact + exploitability, 10);
  return roundCvssUp(base);
}

function cvssV2BaseScore(metrics: Map<string, string>): number | null {
  const av = cvssMetricWeight(CVSS_V2_AV, metrics.get("AV"));
  const ac = cvssMetricWeight(CVSS_V2_AC, metrics.get("AC"));
  const au = cvssMetricWeight(CVSS_V2_AU, metrics.get("AU"));
  const c = cvssMetricWeight(CVSS_V2_CIA, metrics.get("C"));
  const i = cvssMetricWeight(CVSS_V2_CIA, metrics.get("I"));
  const a = cvssMetricWeight(CVSS_V2_CIA, metrics.get("A"));
  if (av === null || ac === null || au === null || c === null || i === null || a === null) {
    return null;
  }

  // CVSS v2.0 base-score equation — constants straight from the First
  // (and only) CVSS v2 spec, §2.2.1 "Base Equation" and §3.2.1 "The
  // Impact Sub-Score Equation" (impact = 10.41·(1-(1-C)(1-I)(1-A))),
  // §3.2.1's exploitability sub-score (20·AV·AC·AU), the f(impact)
  // adjuster 1.176 for any non-zero impact, and the −1.5 base offset.
  // Unlike v3, v2 rounds half-up to one decimal instead of rounding away
  // from zero.
  const impact = 10.41 * (1 - (1 - c) * (1 - i) * (1 - a));
  const exploitability = 20 * av * ac * au;
  const fImpact = impact === 0 ? 0 : 1.176;
  return Math.round((0.6 * impact + 0.4 * exploitability - 1.5) * fImpact * 10) / 10;
}

/**
 * Compute the CVSS base score from a vector string, or null when it isn't
 * a parseable v2/v3 vector. Which formula applies comes from the vector
 * itself — self-describing beats trusting the record's type field: an
 * explicit "CVSS:x.y" prefix wins; otherwise AU (Authentication) only
 * exists in v2 vectors while PR/UI/S only exist in v3.
 */
export function cvssVectorToBaseScore(rawVector: string): number | null {
  const vector = rawVector.trim().toUpperCase();
  if (vector === "" || !vector.includes("/")) return null;

  const metrics = new Map<string, string>();
  let prefix: string | null = null;
  for (const segment of vector.split("/")) {
    const colonAt = segment.indexOf(":");
    if (colonAt <= 0) return null;
    const key = segment.slice(0, colonAt);
    const value = segment.slice(colonAt + 1);
    if (key === "CVSS") {
      prefix = value;
    } else {
      metrics.set(key, value);
    }
  }

  if (prefix !== null) {
    if (prefix.startsWith("3")) return cvssV3BaseScore(metrics);
    if (prefix.startsWith("2")) return cvssV2BaseScore(metrics);
    return null; // CVSS v4 and anything else unsupported
  }

  if (metrics.has("AU")) return cvssV2BaseScore(metrics);
  if (metrics.has("PR") || metrics.has("UI") || metrics.has("S")) {
    return cvssV3BaseScore(metrics);
  }
  return null;
}
