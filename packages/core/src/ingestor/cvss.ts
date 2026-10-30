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
 * exists in v2 vectors while PR/UI/S only exist in v3. (An unprefixed v4
 * vector — which the v4 spec forbids anyway — would sniff as v3 and fail
 * v3 validation, so it also returns null.)
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
    // Exact "4.0" only: a future CVSS 4.1+ could change scoring semantics or
    // add metrics, and scoring it with the v4.0 tables would be silently
    // wrong — null (unparsed severity) beats a plausible wrong number.
    if (prefix === "4.0") return cvssV4BaseScore(metrics);
    return null; // CVSS v5 and anything else unsupported
  }

  if (metrics.has("AU")) return cvssV2BaseScore(metrics);
  if (metrics.has("PR") || metrics.has("UI") || metrics.has("S")) {
    return cvssV3BaseScore(metrics);
  }
  return null;
}

// ---------------------------------------------------------------------------
// CVSS v4.0 base-score computation
//
// v4.0 has no closed-form equation: the base score is the value of the
// vector's "macrovector" (a 6-digit equivalence-class key) in FIRST's
// published lookup table, refined downward by how far the vector sits from
// the highest-severity vector in its class. The tables and algorithm below
// are ported from FIRST's own cvss-v4-calculator reference implementation
// (github.com/FIRSTdotOrg/cvss-v4-calculator — cvss_lookup.js, max_composed.js,
// max_severity.js, cvss_score.js; BSD-2-Clause). The port was verified
// differentially against that implementation (18 vectors incl. threat,
// environmental, and no-impact cases — 18/18 agreement, cross-checked against
// the official Python `cvss` library) before being committed; the test table
// in osv.test.ts carries those verified fixtures.
// ---------------------------------------------------------------------------

/**
 * Macrovector → base score, FIRST's cvssLookup_global (64 entries, verbatim).
 * Key digits are the vector's EQ1..EQ6 equivalence classes (see
 * cvssV4MacroVector). A valid v4.0 vector always lands on one of these —
 * the only macros absent from the table (e.g. 2XXXX0 shapes) are
 * unreachable by construction; an absent key fails safe to null.
 */
const CVSS_V4_MACROVECTOR_SCORES: Record<string, number> = {
  "000000": 10,
  "000001": 9.9,
  "000010": 9.8,
  "000011": 9.5,
  "000020": 9.5,
  "000021": 9.2,
  "000100": 10,
  "000101": 9.6,
  "000110": 9.3,
  "000111": 8.7,
  "000120": 9.1,
  "000121": 8.1,
  "000200": 9.3,
  "000201": 9,
  "000210": 8.9,
  "000211": 8,
  "000220": 8.1,
  "000221": 6.8,
  "001000": 9.8,
  "001001": 9.5,
  "001010": 9.5,
  "001011": 9.2,
  "001020": 9,
  "001021": 8.4,
  "001100": 9.3,
  "001101": 9.2,
  "001110": 8.9,
  "001111": 8.1,
  "001120": 8.1,
  "001121": 6.5,
  "001200": 8.8,
  "001201": 8,
  "001210": 7.8,
  "001211": 7,
  "001220": 6.9,
  "001221": 4.8,
  "002001": 9.2,
  "002011": 8.2,
  "002021": 7.2,
  "002101": 7.9,
  "002111": 6.9,
  "002121": 5,
  "002201": 6.9,
  "002211": 5.5,
  "002221": 2.7,
  "010000": 9.9,
  "010001": 9.7,
  "010010": 9.5,
  "010011": 9.2,
  "010020": 9.2,
  "010021": 8.5,
  "010100": 9.5,
  "010101": 9.1,
  "010110": 9,
  "010111": 8.3,
  "010120": 8.4,
  "010121": 7.1,
  "010200": 9.2,
  "010201": 8.1,
  "010210": 8.2,
  "010211": 7.1,
  "010220": 7.2,
  "010221": 5.3,
  "011000": 9.5,
  "011001": 9.3,
  "011010": 9.2,
  "011011": 8.5,
  "011020": 8.5,
  "011021": 7.3,
  "011100": 9.2,
  "011101": 8.2,
  "011110": 8,
  "011111": 7.2,
  "011120": 7,
  "011121": 5.9,
  "011200": 8.4,
  "011201": 7,
  "011210": 7.1,
  "011211": 5.2,
  "011220": 5,
  "011221": 3,
  "012001": 8.6,
  "012011": 7.5,
  "012021": 5.2,
  "012101": 7.1,
  "012111": 5.2,
  "012121": 2.9,
  "012201": 6.3,
  "012211": 2.9,
  "012221": 1.7,
  "100000": 9.8,
  "100001": 9.5,
  "100010": 9.4,
  "100011": 8.7,
  "100020": 9.1,
  "100021": 8.1,
  "100100": 9.4,
  "100101": 8.9,
  "100110": 8.6,
  "100111": 7.4,
  "100120": 7.7,
  "100121": 6.4,
  "100200": 8.7,
  "100201": 7.5,
  "100210": 7.4,
  "100211": 6.3,
  "100220": 6.3,
  "100221": 4.9,
  "101000": 9.4,
  "101001": 8.9,
  "101010": 8.8,
  "101011": 7.7,
  "101020": 7.6,
  "101021": 6.7,
  "101100": 8.6,
  "101101": 7.6,
  "101110": 7.4,
  "101111": 5.8,
  "101120": 5.9,
  "101121": 5,
  "101200": 7.2,
  "101201": 5.7,
  "101210": 5.7,
  "101211": 5.2,
  "101220": 5.2,
  "101221": 2.5,
  "102001": 8.3,
  "102011": 7,
  "102021": 5.4,
  "102101": 6.5,
  "102111": 5.8,
  "102121": 2.6,
  "102201": 5.3,
  "102211": 2.1,
  "102221": 1.3,
  "110000": 9.5,
  "110001": 9,
  "110010": 8.8,
  "110011": 7.6,
  "110020": 7.6,
  "110021": 7,
  "110100": 9,
  "110101": 7.7,
  "110110": 7.5,
  "110111": 6.2,
  "110120": 6.1,
  "110121": 5.3,
  "110200": 7.7,
  "110201": 6.6,
  "110210": 6.8,
  "110211": 5.9,
  "110220": 5.2,
  "110221": 3,
  "111000": 8.9,
  "111001": 7.8,
  "111010": 7.6,
  "111011": 6.7,
  "111020": 6.2,
  "111021": 5.8,
  "111100": 7.4,
  "111101": 5.9,
  "111110": 5.7,
  "111111": 5.7,
  "111120": 4.7,
  "111121": 2.3,
  "111200": 6.1,
  "111201": 5.2,
  "111210": 5.7,
  "111211": 2.9,
  "111220": 2.4,
  "111221": 1.6,
  "112001": 7.1,
  "112011": 5.9,
  "112021": 3,
  "112101": 5.8,
  "112111": 2.6,
  "112121": 1.5,
  "112201": 2.3,
  "112211": 1.3,
  "112221": 0.6,
  "200000": 9.3,
  "200001": 8.7,
  "200010": 8.6,
  "200011": 7.2,
  "200020": 7.5,
  "200021": 5.8,
  "200100": 8.6,
  "200101": 7.4,
  "200110": 7.4,
  "200111": 6.1,
  "200120": 5.6,
  "200121": 3.4,
  "200200": 7,
  "200201": 5.4,
  "200210": 5.2,
  "200211": 4,
  "200220": 4,
  "200221": 2.2,
  "201000": 8.5,
  "201001": 7.5,
  "201010": 7.4,
  "201011": 5.5,
  "201020": 6.2,
  "201021": 5.1,
  "201100": 7.2,
  "201101": 5.7,
  "201110": 5.5,
  "201111": 4.1,
  "201120": 4.6,
  "201121": 1.9,
  "201200": 5.3,
  "201201": 3.6,
  "201210": 3.4,
  "201211": 1.9,
  "201220": 1.9,
  "201221": 0.8,
  "202001": 6.4,
  "202011": 5.1,
  "202021": 2,
  "202101": 4.7,
  "202111": 2.1,
  "202121": 1.1,
  "202201": 2.4,
  "202211": 0.9,
  "202221": 0.4,
  "210000": 8.8,
  "210001": 7.5,
  "210010": 7.3,
  "210011": 5.3,
  "210020": 6,
  "210021": 5,
  "210100": 7.3,
  "210101": 5.5,
  "210110": 5.9,
  "210111": 4,
  "210120": 4.1,
  "210121": 2,
  "210200": 5.4,
  "210201": 4.3,
  "210210": 4.5,
  "210211": 2.2,
  "210220": 2,
  "210221": 1.1,
  "211000": 7.5,
  "211001": 5.5,
  "211010": 5.8,
  "211011": 4.5,
  "211020": 4,
  "211021": 2.1,
  "211100": 6.1,
  "211101": 5.1,
  "211110": 4.8,
  "211111": 1.8,
  "211120": 2,
  "211121": 0.9,
  "211200": 4.6,
  "211201": 1.8,
  "211210": 1.7,
  "211211": 0.7,
  "211220": 0.8,
  "211221": 0.2,
  "212001": 5.3,
  "212011": 2.4,
  "212021": 1.4,
  "212101": 2.4,
  "212111": 1.2,
  "212121": 0.5,
  "212201": 1,
  "212211": 0.3,
  "212221": 0.1,
};

/**
 * Max severity depths per equivalence class (FIRST's maxSeverity, verbatim
 * minus the unused eq5 entry — eq5's normalized distance is defined to be 0,
 * so its depth is never read).
 */
const CVSS_V4_MAX_SEVERITY: {
  eq1: Record<number, number>;
  eq2: Record<number, number>;
  eq3eq6: Record<number, Record<number, number>>;
  eq4: Record<number, number>;
} = {
  eq1: { 0: 1, 1: 4, 2: 5 },
  eq2: { 0: 1, 1: 2 },
  eq3eq6: { 0: { 0: 7, 1: 6 }, 1: { 0: 8, 1: 8 }, 2: { 1: 10 } },
  eq4: { 0: 6, 1: 5, 2: 4 },
};

/**
 * Highest-severity metric fragments per equivalence class (FIRST's
 * maxComposed, verbatim). eq3's fragments are keyed by the vector's own
 * eq6 class — eq3 and eq6 are a related pair (impact × critical-requirement).
 */
const CVSS_V4_MAX_COMPOSED: {
  eq1: Record<number, string[]>;
  eq2: Record<number, string[]>;
  eq3: Record<number, Record<number, string[]>>;
  eq4: Record<number, string[]>;
  eq5: Record<number, string[]>;
} = {
  eq1: {
    0: ["AV:N/PR:N/UI:N/"],
    1: ["AV:A/PR:N/UI:N/", "AV:N/PR:L/UI:N/", "AV:N/PR:N/UI:P/"],
    2: ["AV:P/PR:N/UI:N/", "AV:A/PR:L/UI:P/"],
  },
  eq2: {
    0: ["AC:L/AT:N/"],
    1: ["AC:H/AT:N/", "AC:L/AT:P/"],
  },
  eq3: {
    0: {
      0: ["VC:H/VI:H/VA:H/CR:H/IR:H/AR:H/"],
      1: ["VC:H/VI:H/VA:L/CR:M/IR:M/AR:H/", "VC:H/VI:H/VA:H/CR:M/IR:M/AR:M/"],
    },
    1: {
      0: ["VC:L/VI:H/VA:H/CR:H/IR:H/AR:H/", "VC:H/VI:L/VA:H/CR:H/IR:H/AR:H/"],
      1: [
        "VC:L/VI:H/VA:L/CR:H/IR:M/AR:H/",
        "VC:L/VI:H/VA:H/CR:H/IR:M/AR:M/",
        "VC:H/VI:L/VA:H/CR:M/IR:H/AR:M/",
        "VC:H/VI:L/VA:L/CR:M/IR:H/AR:H/",
        "VC:L/VI:L/VA:H/CR:H/IR:H/AR:M/",
      ],
    },
    2: { 1: ["VC:L/VI:L/VA:L/CR:H/IR:H/AR:H/"] },
  },
  eq4: {
    0: ["SC:H/SI:S/SA:S/"],
    1: ["SC:H/SI:H/SA:H/"],
    2: ["SC:L/SI:L/SA:L/"],
  },
  eq5: {
    0: ["E:A/"],
    1: ["E:P/"],
    2: ["E:U/"],
  },
};

/** Per-metric severity level indices (cvss_score.js's *_levels tables). */
const CVSS_V4_LEVELS: Record<string, Record<string, number>> = {
  AV: { N: 0, A: 0.1, L: 0.2, P: 0.3 },
  PR: { N: 0, L: 0.1, H: 0.2 },
  UI: { N: 0, P: 0.1, A: 0.2 },
  AC: { L: 0, H: 0.1 },
  AT: { N: 0, P: 0.1 },
  VC: { H: 0, L: 0.1, N: 0.2 },
  VI: { H: 0, L: 0.1, N: 0.2 },
  VA: { H: 0, L: 0.1, N: 0.2 },
  SC: { H: 0.1, L: 0.2, N: 0.3 },
  SI: { S: 0, H: 0.1, L: 0.2, N: 0.3 },
  SA: { S: 0, H: 0.1, L: 0.2, N: 0.3 },
  CR: { H: 0, M: 0.1, L: 0.2 },
  IR: { H: 0, M: 0.1, L: 0.2 },
  AR: { H: 0, M: 0.1, L: 0.2 },
};

/** The 11 mandatory base metrics and their allowed values. */
const CVSS_V4_BASE_METRICS: Record<string, readonly string[]> = {
  AV: ["N", "A", "L", "P"],
  AC: ["L", "H"],
  AT: ["N", "P"],
  PR: ["N", "L", "H"],
  UI: ["N", "P", "A"],
  VC: ["H", "L", "N"],
  VI: ["H", "L", "N"],
  VA: ["H", "L", "N"],
  SC: ["H", "L", "N"],
  SI: ["H", "L", "N"],
  SA: ["H", "L", "N"],
};

/**
 * Every optional metric's allowed values (Safety S is exclusive to MSI/MSA;
 * a base SI:S is impossible because the mandatory base table above only
 * allows H/L/N — per the v4 spec and the reference calculator's metric
 * table).
 */
const CVSS_V4_OPTIONAL_METRICS: Record<string, readonly string[]> = {
  E: ["X", "A", "P", "U"],
  CR: ["X", "H", "M", "L"],
  IR: ["X", "H", "M", "L"],
  AR: ["X", "H", "M", "L"],
  MAV: ["X", "N", "A", "L", "P"],
  MAC: ["X", "L", "H"],
  MAT: ["X", "N", "P"],
  MPR: ["X", "N", "L", "H"],
  MUI: ["X", "N", "P", "A"],
  MVC: ["X", "H", "L", "N"],
  MVI: ["X", "H", "L", "N"],
  MVA: ["X", "H", "L", "N"],
  MSC: ["X", "H", "L", "N"],
  MSI: ["X", "S", "H", "L", "N"],
  MSA: ["X", "S", "H", "L", "N"],
  S: ["X", "N", "P"],
  AU: ["X", "N", "Y"],
  R: ["X", "A", "U", "I"],
  V: ["X", "D", "C"],
  RE: ["X", "L", "M", "H"],
  // cvssVectorToBaseScore uppercases the whole vector before this table is
  // consulted, so the spec's CamelCase U values are matched in uppercase
  // form. U is supplemental and never affects the score, so the
  // normalization is score-neutral by construction.
  U: ["X", "CLEAR", "GREEN", "AMBER", "RED"],
};

/**
 * The reference's m(): resolve a metric to its effective value —
 * environmental overrides (M*) win over base; undefined E defaults to the
 * worst case A; undefined CR/IR/AR default to the worst case H.
 */
function cvssV4EffectiveValue(metrics: Map<string, string>, metric: string): string | undefined {
  const selected = metrics.get(metric);
  if (metric === "E" && selected === "X") return "A";
  if ((metric === "CR" || metric === "IR" || metric === "AR") && selected === "X") return "H";
  const modified = metrics.get(`M${metric}`);
  if (modified !== undefined && modified !== "X") return modified;
  return selected;
}

/**
 * The vector's 6-digit macrovector (EQ1..EQ6), FIRST's macroVector() verbatim.
 * Returns null when a base metric is somehow missing — unreachable after
 * cvssV4BaseScore's validation, but the digit-string must never be built
 * from undefined.
 */
function cvssV4MacroVector(metrics: Map<string, string>): string | null {
  const v = (metric: string): string | undefined => cvssV4EffectiveValue(metrics, metric);

  // EQ1: 0-AV:N and PR:N and UI:N
  //      1-(AV:N or PR:N or UI:N) and not (AV:N and PR:N and UI:N) and not AV:P
  //      2-AV:P or not(AV:N or PR:N or UI:N)
  let eq1: number;
  if (v("AV") === "N" && v("PR") === "N" && v("UI") === "N") {
    eq1 = 0;
  } else if (
    (v("AV") === "N" || v("PR") === "N" || v("UI") === "N") &&
    !(v("AV") === "N" && v("PR") === "N" && v("UI") === "N") &&
    !(v("AV") === "P")
  ) {
    eq1 = 1;
  } else if (v("AV") === "P" || !(v("AV") === "N" || v("PR") === "N" || v("UI") === "N")) {
    eq1 = 2;
  } else {
    return null;
  }

  // EQ2: 0-(AC:L and AT:N); 1-(not(AC:L and AT:N))
  const eq2 = v("AC") === "L" && v("AT") === "N" ? 0 : 1;

  // EQ3: 0-(VC:H and VI:H)
  //      1-(not(VC:H and VI:H) and (VC:H or VI:H or VA:H))
  //      2-not (VC:H or VI:H or VA:H)
  let eq3: number;
  if (v("VC") === "H" && v("VI") === "H") {
    eq3 = 0;
  } else if (
    !(v("VC") === "H" && v("VI") === "H") &&
    (v("VC") === "H" || v("VI") === "H" || v("VA") === "H")
  ) {
    eq3 = 1;
  } else if (!(v("VC") === "H" || v("VI") === "H" || v("VA") === "H")) {
    eq3 = 2;
  } else {
    return null;
  }

  // EQ4: 0-(MSI:S or MSA:S)
  //      1-not (MSI:S or MSA:S) and (SC:H or SI:H or SA:H)
  //      2-not (MSI:S or MSA:S) and not (SC:H or SI:H or SA:H)
  let eq4: number;
  if (v("MSI") === "S" || v("MSA") === "S") {
    eq4 = 0;
  } else if (
    !(v("MSI") === "S" || v("MSA") === "S") &&
    (v("SC") === "H" || v("SI") === "H" || v("SA") === "H")
  ) {
    eq4 = 1;
  } else if (
    !(v("MSI") === "S" || v("MSA") === "S") &&
    !(v("SC") === "H" || v("SI") === "H" || v("SA") === "H")
  ) {
    eq4 = 2;
  } else {
    return null;
  }

  // EQ5: 0-E:A; 1-E:P; 2-E:U (E:X was mapped to A by cvssV4EffectiveValue)
  const e = v("E");
  if (e !== "A" && e !== "P" && e !== "U") return null;
  const eq5 = e === "A" ? 0 : e === "P" ? 1 : 2;

  // EQ6: 0-(CR:H and VC:H) or (IR:H and VI:H) or (AR:H and VA:H)
  //      1-not[(CR:H and VC:H) or (IR:H and VI:H) or (AR:H and VA:H)]
  const eq6 =
    (v("CR") === "H" && v("VC") === "H") ||
    (v("IR") === "H" && v("VI") === "H") ||
    (v("AR") === "H" && v("VA") === "H")
      ? 0
      : 1;

  return [eq1, eq2, eq3, eq4, eq5, eq6].map(String).join("");
}

/** FIRST's extractValueMetric: pull one metric's value out of a max-fragment string. */
function cvssV4ExtractValueMetric(metric: string, fragment: string): string {
  const extracted = fragment.slice(fragment.indexOf(metric) + metric.length + 1);
  const slashAt = extracted.indexOf("/");
  return slashAt > 0 ? extracted.substring(0, slashAt) : extracted;
}

function cvssV4BaseScore(metrics: Map<string, string>): number | null {
  // Validation: all 11 base metrics present with allowed values; every other
  // metric must be a known optional one within its allowed set (unknown
  // metrics rejected — a typo'd or future metric silently ignored would
  // score a different vector than the one in the record; base SI:S/SA:S are
  // impossible because the base table only allows H/L/N — safety S is an
  // MSI/MSA-only value). Fail safe like v2/v3: no partial guess.
  for (const [metric, allowed] of Object.entries(CVSS_V4_BASE_METRICS)) {
    const value = metrics.get(metric);
    if (value === undefined || !allowed.includes(value)) return null;
  }
  for (const [metric, value] of metrics.entries()) {
    if (metric in CVSS_V4_BASE_METRICS || metric === "CVSS") continue;
    if (CVSS_V4_OPTIONAL_METRICS[metric]?.includes(value) !== true) return null;
  }

  // Working copy with the reference calculator's defaults for unset
  // threat/environmental metrics (X — cvssV4EffectiveValue maps them to the
  // worst case). M* and supplemental metrics may stay absent.
  const selected = new Map(metrics);
  for (const metric of ["E", "CR", "IR", "AR"]) {
    if (!selected.has(metric)) selected.set(metric, "X");
  }

  // Exception for no impact on system (reference shortcut): every impact
  // metric at N means zero base score regardless of exploitability.
  if (
    ["VC", "VI", "VA", "SC", "SI", "SA"].every(
      (metric) => cvssV4EffectiveValue(selected, metric) === "N",
    )
  ) {
    return 0;
  }

  const macro = cvssV4MacroVector(selected);
  if (macro === null) return null;
  const value = CVSS_V4_MACROVECTOR_SCORES[macro];
  if (value === undefined) return null; // unreachable macrovector — fail safe

  const eq1 = Number(macro[0]);
  const eq2 = Number(macro[1]);
  const eq3 = Number(macro[2]);
  const eq4 = Number(macro[3]);
  const eq5 = Number(macro[4]);
  const eq6 = Number(macro[5]);

  // 1a. Maximal scoring difference per EQ: the distance down to the next
  //     lower macrovector's score. Missing lower macros become NaN and are
  //     excluded from the refinement mean (reference behavior).
  const macroAt = (
    eq1v: number,
    eq2v: number,
    eq3v: number,
    eq4v: number,
    eq5v: number,
    eq6v: number,
  ): string => [eq1v, eq2v, eq3v, eq4v, eq5v, eq6v].map(String).join("");

  const scoreOf = (key: string): number => CVSS_V4_MACROVECTOR_SCORES[key] ?? Number.NaN;

  const scoreEq1NextLower = scoreOf(macroAt(eq1 + 1, eq2, eq3, eq4, eq5, eq6));
  const scoreEq2NextLower = scoreOf(macroAt(eq1, eq2 + 1, eq3, eq4, eq5, eq6));

  // eq3 and eq6 are related — their "next lower" follows the reference's
  // case table; the (0,0) case has two paths and takes the higher score.
  let scoreEq3Eq6NextLower: number;
  if (eq3 === 0 && eq6 === 0) {
    const left = scoreOf(macroAt(eq1, eq2, eq3, eq4, eq5, eq6 + 1));
    const right = scoreOf(macroAt(eq1, eq2, eq3 + 1, eq4, eq5, eq6));
    scoreEq3Eq6NextLower = left > right ? left : right;
  } else if ((eq3 === 1 && eq6 === 1) || (eq3 === 0 && eq6 === 1)) {
    scoreEq3Eq6NextLower = scoreOf(macroAt(eq1, eq2, eq3 + 1, eq4, eq5, eq6));
  } else if (eq3 === 1 && eq6 === 0) {
    scoreEq3Eq6NextLower = scoreOf(macroAt(eq1, eq2, eq3, eq4, eq5, eq6 + 1));
  } else {
    // (2,1): next lower macro does not exist (reference's 21 → 32 case).
    scoreEq3Eq6NextLower = scoreOf(macroAt(eq1, eq2, eq3 + 1, eq4, eq5, eq6 + 1));
  }

  const scoreEq4NextLower = scoreOf(macroAt(eq1, eq2, eq3, eq4 + 1, eq5, eq6));
  const scoreEq5NextLower = scoreOf(macroAt(eq1, eq2, eq3, eq4, eq5 + 1, eq6));

  // 1b. Severity distance from the to-be-scored vector to a
  //     highest-severity vector in the same macrovector. Compose the
  //     per-EQ max fragments and take the first combination that is
  //     nowhere more severe than the vector (reference's scan order).
  const eq1Maxes = CVSS_V4_MAX_COMPOSED.eq1[eq1] ?? [];
  const eq2Maxes = CVSS_V4_MAX_COMPOSED.eq2[eq2] ?? [];
  const eq3Eq6Maxes = CVSS_V4_MAX_COMPOSED.eq3[eq3]?.[eq6] ?? [];
  const eq4Maxes = CVSS_V4_MAX_COMPOSED.eq4[eq4] ?? [];
  const eq5Maxes = CVSS_V4_MAX_COMPOSED.eq5[eq5] ?? [];

  const distanceMetrics = [
    "AV",
    "PR",
    "UI",
    "AC",
    "AT",
    "VC",
    "VI",
    "VA",
    "SC",
    "SI",
    "SA",
    "CR",
    "IR",
    "AR",
  ] as const;

  let currentEq1 = 0;
  let currentEq2 = 0;
  let currentEq3Eq6 = 0;
  let currentEq4 = 0;
  let foundMax = false;

  for (const eq1Max of eq1Maxes) {
    if (foundMax) break;
    for (const eq2Max of eq2Maxes) {
      if (foundMax) break;
      for (const eq3Eq6Max of eq3Eq6Maxes) {
        if (foundMax) break;
        for (const eq4Max of eq4Maxes) {
          if (foundMax) break;
          for (const eq5Max of eq5Maxes) {
            const maxVector = eq1Max + eq2Max + eq3Eq6Max + eq4Max + eq5Max;

            const distances = distanceMetrics.map((metric) => {
              const selectedValue = cvssV4EffectiveValue(selected, metric) ?? "";
              const maxValue = cvssV4ExtractValueMetric(metric, maxVector);
              const selectedLevel = CVSS_V4_LEVELS[metric]?.[selectedValue];
              const maxLevel = CVSS_V4_LEVELS[metric]?.[maxValue];
              if (selectedLevel === undefined || maxLevel === undefined) return Number.NaN;
              return selectedLevel - maxLevel;
            });
            if (distances.some((distance) => Number.isNaN(distance) || distance < 0)) {
              continue; // this max combination is more severe than the vector
            }

            // First qualifying max wins (reference: "it is enough the first one") —
            // including when every distance is 0 (the vector IS a max vector).
            // distanceMetrics has exactly 14 entries, so the indices below are
            // always in range; the guards keep noUncheckedIndexedAccess happy.
            const [av, pr, ui, ac, at, vc, vi, va, sc, si, sa, cr, ir, ar] = distances;
            if (
              av === undefined ||
              pr === undefined ||
              ui === undefined ||
              ac === undefined ||
              at === undefined ||
              vc === undefined ||
              vi === undefined ||
              va === undefined ||
              sc === undefined ||
              si === undefined ||
              sa === undefined ||
              cr === undefined ||
              ir === undefined ||
              ar === undefined
            ) {
              continue;
            }
            currentEq1 = av + pr + ui;
            currentEq2 = ac + at;
            currentEq3Eq6 = vc + vi + va + cr + ir + ar;
            currentEq4 = sc + si + sa;
            foundMax = true;
            break;
          }
        }
      }
    }
  }

  // 1c/1d. Normalize each EQ's available distance by its max-severity depth
  //     (× 0.1 step, as in the reference) and weight by the severity
  //     distance. EQ5's contribution is defined to be 0.
  const step = 0.1;
  let nExistingLower = 0;
  let normalizedSum = 0;

  const accumulate = (
    availableDistance: number,
    severityDistance: number,
    maxDepth: number,
  ): void => {
    if (Number.isNaN(availableDistance)) return;
    nExistingLower += 1;
    normalizedSum +=
      maxDepth === 0 ? 0 : availableDistance * (severityDistance / (maxDepth * step));
  };

  accumulate(value - scoreEq1NextLower, currentEq1, CVSS_V4_MAX_SEVERITY.eq1[eq1] ?? 0);
  accumulate(value - scoreEq2NextLower, currentEq2, CVSS_V4_MAX_SEVERITY.eq2[eq2] ?? 0);
  accumulate(
    value - scoreEq3Eq6NextLower,
    currentEq3Eq6,
    CVSS_V4_MAX_SEVERITY.eq3eq6[eq3]?.[eq6] ?? 0,
  );
  accumulate(value - scoreEq4NextLower, currentEq4, CVSS_V4_MAX_SEVERITY.eq4[eq4] ?? 0);
  // eq5: available distance exists but its severity distance is always 0
  // (reference: percent_to_next_eq5_severity = 0).
  if (!Number.isNaN(value - scoreEq5NextLower)) {
    nExistingLower += 1;
  }

  // 2. Mean of the proportional distances (0 when no lower macro exists —
  //    "sometimes we need to go up but there is nothing there … so it's a
  //    change of 0", reference comment).
  const meanDistance = nExistingLower === 0 ? 0 : normalizedSum / nExistingLower;

  // 3. Macrovector score minus the mean distance, clamped and rounded to
  //    one decimal (reference clamps to [0, 10] then rounds).
  const refined = value - meanDistance;
  const clamped = Math.min(Math.max(refined, 0), 10);
  return Math.round(clamped * 10) / 10;
}
