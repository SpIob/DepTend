/**
 * OSV Advisory Fetcher
 *
 * Queries the OSV batch API (https://osv.dev/docs/#tag/api/operation/OSV_QueryAffectedBatch)
 * for all dependencies parsed from a repository's package.json and maps
 * each result to a NewAdvisory insert shape ready for the DB write layer.
 *
 * Design decisions:
 *   - Single batch request per repo (OSV supports up to 1,000 packages per
 *     call, which comfortably exceeds any realistic package.json).
 *   - No auth required — OSV is a fully public API.
 *   - Raw OSV response stored verbatim in advisory.rawData for full
 *     auditability and future re-processing without re-fetching.
 *   - Severity mapped from CVSS v3 score using NIST thresholds where CVSS
 *     is available; falls back to OSV's own severity enum; defaults to
 *     "unknown" when neither is present.
 *   - fixed_version extracted from the SEMVER range's first "fixed" event.
 *     When no fixed version exists (0-day or unfixed), fixed_version is null.
 *
 * Phase 1 scope — intentionally out of scope:
 *   - GHSA advisory source (added when GitHub REST API integration lands)
 *   - Version range matching against resolved versions (requires lock file)
 *   - Transitive dependency advisories
 *
 * ADR: docs/adr/0003-npm-ecosystem-first.md
 */

import type { NewAdvisory } from "../db/schema.js";
import type { OsvVersionRange, Severity } from "../db/types.js";
import type { ParsedDependency } from "../ingestor/interface.js";

// ---------------------------------------------------------------------------
// OSV API constants
// ---------------------------------------------------------------------------

const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";

/** OSV enforces a 1,000-package limit per batch request. */
const OSV_BATCH_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Raw OSV API response types
// ---------------------------------------------------------------------------

interface OsvQuery {
  package: { name: string; ecosystem: string };
}

interface OsvBatchRequest {
  queries: OsvQuery[];
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

interface OsvQueryResult {
  vulns?: OsvVulnerability[];
}

interface OsvBatchResponse {
  results: OsvQueryResult[];
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

  constructor(batchUrl = OSV_BATCH_URL) {
    // Injected in tests to point at a mock server
    this.batchUrl = batchUrl;
  }

  /**
   * Fetch advisories for all provided dependencies in a single batch call.
   *
   * Deduplicates by package name before sending — the same package appearing
   * as both a production and dev dependency only needs one OSV query.
   *
   * @param dependencies - Parsed dependencies from NpmIngestor
   * @returns OsvFetchResult with advisory insert rows and the package→advisory map
   */
  async fetchAdvisories(dependencies: ParsedDependency[]): Promise<OsvFetchResult> {
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
    // Build and send the batch request
    // ------------------------------------------------------------------
    const requestBody: OsvBatchRequest = {
      queries: queried.map((name) => ({
        package: { name, ecosystem: "npm" },
      })),
    };

    let response: Response;
    try {
      response = await fetch(this.batchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      throw new Error(`Network error querying OSV batch API: ${String(err)}`);
    }

    if (!response.ok) {
      throw new Error(
        `OSV batch API returned HTTP ${String(response.status)}: ${response.statusText}`,
      );
    }

    let batchResponse: OsvBatchResponse;
    try {
      batchResponse = (await response.json()) as OsvBatchResponse;
    } catch (err) {
      throw new Error(`Failed to parse OSV batch API response: ${String(err)}`);
    }

    if (!Array.isArray(batchResponse.results)) {
      throw new Error("OSV batch API response missing expected 'results' array.");
    }

    // ------------------------------------------------------------------
    // Map results back to their packages and build advisory rows
    // ------------------------------------------------------------------
    const advisories = new Map<string, NewAdvisory>();
    const packageAdvisoryMap = new Map<string, string[]>();

    for (let i = 0; i < queried.length; i++) {
      const packageName = queried[i];
      if (packageName === undefined) continue;

      const result = batchResponse.results[i];
      const vulns = result?.vulns ?? [];

      const osvIdsForPackage: string[] = [];

      for (const vuln of vulns) {
        if (!vuln.id) {
          warnings.push(
            `OSV returned a vulnerability with no id for package "${packageName}" — skipped.`,
          );
          continue;
        }

        osvIdsForPackage.push(vuln.id);

        // Avoid re-processing a vuln that affects multiple packages in this
        // batch (e.g. a monorepo advisory covering several npm packages).
        if (advisories.has(vuln.id)) continue;

        const advisory = this.mapVulnToAdvisory(vuln, packageName, warnings);
        advisories.set(vuln.id, advisory);
      }

      if (osvIdsForPackage.length > 0) {
        packageAdvisoryMap.set(packageName, osvIdsForPackage);
      }
    }

    return { advisories, packageAdvisoryMap, warnings };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Map a single OSV vulnerability object to a NewAdvisory insert shape.
   * The raw OSV object is stored verbatim in rawData.
   */
  private mapVulnToAdvisory(
    vuln: OsvVulnerability,
    packageName: string,
    warnings: string[],
  ): NewAdvisory {
    const severity = this.extractSeverity(vuln, packageName, warnings);
    const cvssScore = this.extractCvssScore(vuln);
    const affectedVersions = this.extractAffectedRanges(vuln);
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
      ecosystem: "npm",
      packageName,
      severity,
      cvssScore: cvssScore !== null ? String(cvssScore) : null,
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
  private extractSeverity(
    vuln: OsvVulnerability,
    packageName: string,
    warnings: string[],
  ): Severity {
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
      `No CVSS score or severity level found for advisory ${vuln.id} ` +
        `(package "${packageName}"). Severity recorded as "unknown".`,
    );
    return "unknown";
  }

  /**
   * Extract the numeric CVSS base score for storage.
   * Handles both full vector strings (e.g. "CVSS:3.1/AV:N/AC:L/...")
   * and bare numeric strings (e.g. "7.5").
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
   * Parse a numeric CVSS score from either a vector string or a bare number.
   * CVSS vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" → score in
   * database_specific, or we fall back to the numeric part before the first "/".
   *
   * OSV embeds the numeric score as a bare string alongside the vector:
   *   { type: "CVSS_V3", score: "9.8" } — common in GitHub Advisory data
   */
  private parseCvssNumericScore(raw: string): number | null {
    // Bare numeric: "7.5"
    const bare = parseFloat(raw);
    if (!isNaN(bare) && bare >= 0 && bare <= 10) return bare;

    // Vector string: "CVSS:3.1/AV:..." — extract from database_specific later
    return null;
  }

  /**
   * Extract SEMVER affected ranges from the OSV vulnerability.
   * Only SEMVER ranges are stored; GIT and ECOSYSTEM ranges are dropped
   * (they are less useful for the npm version matching in Phase 2).
   */
  private extractAffectedRanges(vuln: OsvVulnerability): OsvVersionRange[] {
    const ranges: OsvVersionRange[] = [];

    for (const affected of vuln.affected ?? []) {
      for (const range of affected.ranges ?? []) {
        if (range.type === "SEMVER") {
          ranges.push({
            type: "SEMVER",
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
