/**
 * CVSS (Common Vulnerability Scoring System) utilities
 *
 * Pure functions for computing CVSS base scores from vector strings and
 * mapping numeric scores to severity levels. Extracted from osv.ts for reuse
 * and testability.
 */

import type { Severity } from "../db/schema.js";

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
