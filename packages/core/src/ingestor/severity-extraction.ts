/**
 * Shared CVSS/severity extraction logic
 *
 * Extracted from OsvFetcher to be reusable by both the OSV detail-fetch mapping
 * and the alias-based severity recovery stage (ADR 0068). All functions are
 * pure and testable in isolation.
 *
 * ADR: docs/adr/0061-2026-10-22-ingestion-scoring-audit-fixes.md (CVSS v4 port)
 */

import type { OsvVulnerability, OsvSeverity } from "./osv.js";
import type { Severity } from "../db/schema.js";
import { cvssScoreToSeverity, cvssVectorToBaseScore, mapStringSeverity } from "./cvss.js";

/**
 * Parse a numeric CVSS base score from either a bare number or a vector string.
 *
 * Bare numeric: "7.5" — common in GitHub Advisory data
 *   { type: "CVSS_V3", score: "9.8" }.
 * Vector string: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" — the
 * base score is COMPUTED from the vector's own metrics per the CVSS v3.1
 * (or v2/v4) specification; it is not stored anywhere else in the record.
 * Returns null when neither form parses.
 */
export function parseCvssNumericScore(raw: string): number | null {
  // Bare numeric: "7.5"
  const bare = parseFloat(raw);
  if (!isNaN(bare) && bare >= 0 && bare <= 10) return bare;

  // Vector string — compute the base score from its metrics
  return cvssVectorToBaseScore(raw);
}

/**
 * Extract the numeric CVSS base score for storage from an OSV vulnerability's
 * severity array. Handles both full vector strings and bare numeric strings.
 * Returns null when no parseable CVSS score exists.
 */
export function extractCvssScore(vuln: OsvVulnerability): number | null {
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
 *
 * NIST CVSS v3 thresholds (v4 uses the same qualitative bands):
 *   Critical ≥ 9.0 | High ≥ 7.0 | Medium ≥ 4.0 | Low ≥ 0.1 | None = 0.0
 */
export function extractSeverity(vuln: OsvVulnerability, warnings: string[]): Severity {
  // 1. Try CVSS v4 numeric score
  const cvss4 = vuln.severity?.find((s: OsvSeverity) => s.type === "CVSS_V4");
  if (cvss4) {
    const score = parseCvssNumericScore(cvss4.score);
    if (score !== null) return cvssScoreToSeverity(score);
  }

  // 2. Try CVSS v3 numeric score
  const cvss3 = vuln.severity?.find((s: OsvSeverity) => s.type === "CVSS_V3");
  if (cvss3) {
    const score = parseCvssNumericScore(cvss3.score);
    if (score !== null) return cvssScoreToSeverity(score);
  }

  // 3. Try CVSS v2 numeric score
  const cvss2 = vuln.severity?.find((s: OsvSeverity) => s.type === "CVSS_V2");
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
 * Shape of a recovered severity record from an alias lookup.
 */
export interface RecoveredSeverity {
  severity: Severity;
  cvssScore: number | null;
}
