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
 * ADR: docs/adr/0003-npm-ecosystem-first.md (ecosystem choice)
 *      docs/adr/0010-osv-fetcher-detail-fetch-fix.md (batch/detail split)
 */

import type { NewAdvisory } from "../db/schema.js";
import type { OsvVersionRange, Severity } from "../db/types.js";
import type { ParsedDependency } from "../ingestor/interface.js";

// ---------------------------------------------------------------------------
// OSV API constants
// ---------------------------------------------------------------------------

const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const OSV_VULN_BASE_URL = "https://api.osv.dev/v1/vulns";

/** OSV enforces a 1,000-package limit per batch request. */
const OSV_BATCH_LIMIT = 1000;

/** Default number of in-flight GET /v1/vulns/{id} requests at once. */
const DEFAULT_DETAIL_CONCURRENCY = 10;

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

  constructor(
    batchUrl = OSV_BATCH_URL,
    vulnUrlBase = OSV_VULN_BASE_URL,
    concurrency = DEFAULT_DETAIL_CONCURRENCY,
  ) {
    // Injected in tests to point at a mock server
    this.batchUrl = batchUrl;
    this.vulnUrlBase = vulnUrlBase;
    this.concurrency = concurrency;
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
    // Stage 1: batch query — returns only {id, modified} per result
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
   */
  private async fetchFullDetails(
    ids: string[],
    firstPackageForId: Map<string, string>,
    warnings: string[],
  ): Promise<{ advisories: Map<string, NewAdvisory>; failedIds: Set<string> }> {
    const advisories = new Map<string, NewAdvisory>();
    const failedIds = new Set<string>();

    let index = 0;

    const worker = async (): Promise<void> => {
      while (index < ids.length) {
        const current = index++;
        const id = ids[current];
        if (id === undefined) continue;

        try {
          const vuln = await this.fetchVulnById(id);
          // Guaranteed present: every id here came from firstPackageForId's
          // own key set (built from the same ids in fetchAdvisories).
          const packageName = firstPackageForId.get(id) ?? "";
          advisories.set(id, this.mapVulnToAdvisory(vuln, packageName, warnings));
        } catch (err) {
          failedIds.add(id);
          warnings.push(
            `Failed to fetch full details for advisory ${id}: ${String(err)}. ` +
              `Skipped — this advisory will not appear in results this run.`,
          );
        }
      }
    };

    const workers = Array.from({ length: Math.min(this.concurrency, ids.length) }, () => worker());
    await Promise.all(workers);

    return { advisories, failedIds };
  }

  private async fetchVulnById(id: string): Promise<OsvVulnerability> {
    let response: Response;
    try {
      response = await fetch(`${this.vulnUrlBase}/${encodeURIComponent(id)}`);
    } catch (err) {
      throw new Error(`Network error: ${String(err)}`);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}`);
    }

    try {
      return (await response.json()) as OsvVulnerability;
    } catch (err) {
      throw new Error(`Failed to parse response: ${String(err)}`);
    }
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
    warnings: string[],
  ): NewAdvisory {
    const severity = this.extractSeverity(vuln, warnings);
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
