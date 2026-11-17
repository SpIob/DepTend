/**
 * Severity/CVSS recovery from OSV aliases (ADR 0068)
 *
 * When an advisory record lacks severity/CVSS (common for OSV-native sources
 * like PYSEC/GO), we can often recover it by querying the GHSA or CVE alias
 * that OSV already returned in the advisory's `aliases` array. The alias
 * record (e.g. a GHSA entry) typically carries a full severity array and
 * CVSS vector, which our shared extraction logic can parse.
 *
 * Design decisions (per ADR 0039's fail-soft discipline):
 *   - Batched: up to 100 alias IDs per request via repeated comma-separated
 *     requests to GET /v1/vulns/{id}, run with bounded concurrency.
 *   - Non-fatal: any chunk failure warns and leaves those advisories unchanged.
 *   - Only recovers gaps: an advisory that already has severity/CVSS is not
 *     re-queried. A recovered value only fills a null/unknown slot.
 *   - Preference order: GHSA alias first (richer metadata), then CVE alias.
 *   - Deduplicated by alias ID: multiple advisories sharing the same CVE
 *     alias are served by one fetch.
 *
 * ADR: docs/adr/0068-2026-11-17-ingestion-scoring-followups.md
 */

import type { NewAdvisory } from "../db/schema.js";
import type { RecoveredSeverity } from "./severity-extraction.js";
import { DEFAULT_RETRY_DELAY_MS } from "./fetch-retry.js";
import { fetchJson } from "./fetch-json.js";
import { runBounded } from "./concurrency.js";
import { cvssScoreToSeverity, cvssVectorToBaseScore, mapStringSeverity } from "./cvss.js";

const OSV_VULN_BASE_URL = "https://api.osv.dev/v1/vulns";

/** Maximum alias IDs per request (OSV's documented batch size for querybatch is 1000, but single-vuln is 1:1; we batch by alias ID). */
const RECOVERY_BATCH_SIZE = 100;

/** Default number of in-flight alias recovery requests at once. */
const DEFAULT_RECOVERY_CONCURRENCY = 5;

interface OsvSeverityRecord {
  type: string;
  score: string;
}

interface OsvVulnAliasRecord {
  id: string;
  modified?: string;
  published?: string;
  aliases?: string[];
  severity?: OsvSeverityRecord[];
  database_specific?: { severity?: string; cvss?: unknown };
  affected?: {
    package?: { name: string; ecosystem: string };
    ranges?: {
      type: string;
      events: { introduced?: string; fixed?: string; last_affected?: string }[];
    }[];
  };
  summary?: string;
  details?: string;
  references?: { type: string; url: string }[];
}

/**
 * Parse a numeric CVSS base score from either a bare number or a vector string.
 * (Duplicated from severity-extraction to avoid exactOptionalPropertyTypes issues
 * when passing alias records through the shared functions.)
 */
function parseCvssNumericScore(raw: string): number | null {
  const bare = parseFloat(raw);
  if (!isNaN(bare) && bare >= 0 && bare <= 10) return bare;
  return cvssVectorToBaseScore(raw);
}

/**
 * Extract the numeric CVSS base score for storage from an OSV vulnerability's
 * severity array. Handles both full vector strings and bare numeric strings.
 * Returns null when no parseable CVSS score exists.
 */
function extractCvssScoreFromAlias(vuln: OsvVulnAliasRecord): number | null {
  for (const sev of vuln.severity ?? []) {
    if (sev.type === "CVSS_V4" || sev.type === "CVSS_V3" || sev.type === "CVSS_V2") {
      const score = parseCvssNumericScore(sev.score);
      if (score !== null) return score;
    }
  }
  return null;
}

/**
 * Derive severity from CVSS v4 score (preferred) → CVSS v3 → CVSS v2 →
 * OSV's own database_specific.severity field → "unknown".
 */
function extractSeverityFromAlias(
  vuln: OsvVulnAliasRecord,
  warnings: string[],
): "critical" | "high" | "medium" | "low" | "unknown" {
  // 1. Try CVSS v4 numeric score
  const cvss4 = vuln.severity?.find((s) => s.type === "CVSS_V4");
  if (cvss4) {
    const score = parseCvssNumericScore(cvss4.score);
    if (score !== null) return cvssScoreToSeverity(score);
  }

  // 2. Try CVSS v3 numeric score
  const cvss3 = vuln.severity?.find((s) => s.type === "CVSS_V3");
  if (cvss3) {
    const score = parseCvssNumericScore(cvss3.score);
    if (score !== null) return cvssScoreToSeverity(score);
  }

  // 3. Try CVSS v2 numeric score
  const cvss2 = vuln.severity?.find((s) => s.type === "CVSS_V2");
  if (cvss2) {
    const score = parseCvssNumericScore(cvss2.score);
    if (score !== null) return cvssScoreToSeverity(score);
  }

  // 4. Try database_specific.severity string (e.g. GitHub Advisory DB)
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
 * Fetch severity/CVSS for a single alias ID.
 * Returns { severity, cvssScore } or null if not found/parsable.
 */
export async function fetchSeverityByAliasId(
  aliasId: string,
  baseUrl = OSV_VULN_BASE_URL,
  retryDelayMs: number = DEFAULT_RETRY_DELAY_MS,
): Promise<RecoveredSeverity | null> {
  try {
    const vuln = await fetchJson<OsvVulnAliasRecord>(
      `${baseUrl}/${encodeURIComponent(aliasId)}`,
      undefined,
      { fetchOptions: { retryDelayMs }, errorPrefix: "OSV alias recovery" },
    );

    const warnings: string[] = [];
    const severity = extractSeverityFromAlias(vuln, warnings);
    const cvssScore = extractCvssScoreFromAlias(vuln);

    if (severity === "unknown" && cvssScore === null) return null;
    return { severity, cvssScore };
  } catch {
    return null;
  }
}

/**
 * Enrich freshly-fetched advisories with severity/CVSS recovered from their
 * GHSA/CVE aliases. Runs after the EPSS enrichment (which also runs after
 * detail fetches). Non-fatal by design: failures warn and leave the original
 * values unchanged.
 *
 * @param advisories Map of advisory rows ready for upsert (mutated in place)
 * @param warnings Accumulator for data-quality warnings
 * @param baseUrl OSV vulnerability base URL (for test injection)
 * @param concurrency Max in-flight recovery requests
 * @param retryDelayMs Flat backoff delay for transient failures
 */
export async function enrichAdvisoriesWithSeverity(
  advisories: Map<string, NewAdvisory>,
  warnings: string[],
  baseUrl = OSV_VULN_BASE_URL,
  concurrency = DEFAULT_RECOVERY_CONCURRENCY,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
): Promise<void> {
  // Collect (advisoryKey, aliasId) pairs for advisories needing recovery,
  // preferring GHSA aliases, then CVE aliases.
  const recoveryTargets: { advisoryKey: string; aliasId: string }[] = [];
  const seenAliasIds = new Set<string>();

  for (const [key, advisory] of advisories) {
    const needsSeverity = advisory.severity === "unknown";
    const needsCvss = advisory.cvssScore === null;
    if (!needsSeverity && !needsCvss) continue;

    const aliases = (advisory.rawData as { aliases?: unknown } | null)?.aliases;
    if (!Array.isArray(aliases)) continue;

    // Prefer GHSA first, then CVE
    let preferred: string | null = null;
    for (const alias of aliases) {
      if (typeof alias === "string" && alias.startsWith("GHSA-")) {
        preferred = alias;
        break;
      }
    }
    if (preferred === null) {
      for (const alias of aliases) {
        if (typeof alias === "string" && alias.startsWith("CVE-")) {
          preferred = alias;
          break;
        }
      }
    }
    if (preferred !== null && !seenAliasIds.has(preferred)) {
      seenAliasIds.add(preferred);
      recoveryTargets.push({ advisoryKey: key, aliasId: preferred });
    }
  }

  if (recoveryTargets.length === 0) return;

  // Chunk into batches
  const chunks: (typeof recoveryTargets)[] = [];
  for (let i = 0; i < recoveryTargets.length; i += RECOVERY_BATCH_SIZE) {
    chunks.push(recoveryTargets.slice(i, i + RECOVERY_BATCH_SIZE));
  }

  // Run bounded concurrency
  const results = await runBounded(chunks, concurrency, async (chunk) => {
    const chunkResults: {
      advisoryKey: string;
      aliasId: string;
      recovery: RecoveredSeverity | null;
    }[] = [];
    for (const { advisoryKey, aliasId } of chunk) {
      try {
        const recovery = await fetchSeverityByAliasId(aliasId, baseUrl, retryDelayMs);
        chunkResults.push({ advisoryKey, aliasId, recovery });
      } catch (err) {
        chunkResults.push({ advisoryKey, aliasId, recovery: null });
        warnings.push(
          `Severity recovery failed for ${aliasId}: ${String(err)}. Advisory keeps original values.`,
        );
      }
    }
    return chunkResults;
  });

  let matched = 0;
  for (const chunkResult of results) {
    for (const { advisoryKey, recovery } of chunkResult) {
      if (recovery === null) continue;
      const advisory = advisories.get(advisoryKey);
      if (!advisory) continue;

      let changed = false;
      if (advisory.severity === "unknown" && recovery.severity !== "unknown") {
        advisory.severity = recovery.severity;
        changed = true;
      }
      if (advisory.cvssScore === null && recovery.cvssScore !== null) {
        advisory.cvssScore = recovery.cvssScore;
        changed = true;
      }
      if (changed) {
        matched++;
      }
    }
  }

  if (matched === 0 && recoveryTargets.length > 0) {
    warnings.push(
      `Severity recovery queried ${String(recoveryTargets.length)} alias(es) but none filled a gap. ` +
        `Scores may be unavailable at OSV for these aliases.`,
    );
  }
}
