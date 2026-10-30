/**
 * ImpactScorer
 *
 * Computes a 0.0–10.0 impact score for a single advisory affecting a
 * dependency: how bad this is if left unaddressed. Driven primarily by
 * CVSS/severity, adjusted for dependency type (blast radius) and, only
 * when transitivity is inferred rather than lock-file-confirmed, a small
 * confidence discount.
 *
 * days_since_advisory is carried through in the returned inputs for
 * transparency but does not affect the score in scoring_version 1.0.0 —
 * see ADR 0006, "No recency modifier in v1".
 *
 * ADR: docs/adr/0006-scoring-algorithm.md
 */

import type { DepType, Severity } from "../db/schema.js";
import type { ImpactInputs } from "../db/json-types.js";

// ---------------------------------------------------------------------------
// Weights (scoring_version 1.0.0 — see ADR 0006)
// ---------------------------------------------------------------------------

/**
 * Base score used only when cvss_score is null. Deliberately conservative:
 * "unknown" gets the floor, not a middle value — we should never imply
 * confidence we don't have.
 */
function severityFallbackScore(severity: Severity): number {
  switch (severity) {
    case "critical":
      return 9.0;
    case "high":
      return 7.0;
    case "medium":
      return 5.0;
    case "low":
      return 2.5;
    case "unknown":
      return 1.0;
    default:
      throw new Error(`Unhandled severity: ${String(severity)}`);
  }
}

/** Reflects blast radius, not fixability: production deps ship to end users. */
function depTypeWeight(depType: DepType): number {
  switch (depType) {
    case "production":
      return 1.0;
    case "peer":
      return 0.9;
    case "optional":
      return 0.6;
    case "development":
      return 0.4;
    default:
      throw new Error(`Unhandled dep_type: ${depType}`);
  }
}

/**
 * Applied whenever is_transitive is true. The discount reflects that
 * transitivity may be inferred rather than lock-file-confirmed
 * (ADR 0006), not a claim that transitive vulnerabilities matter less.
 * Revisit this scorer if/when a confirmed-transitive signal becomes
 * available.
 */
const UNCONFIRMED_TRANSITIVE_DISCOUNT = 0.9;

/**
 * EPSS exploitability boost factor (scoring_version 1.1.0 — see ADR 0038).
 * When an advisory has an EPSS score, the base impact is multiplied by
 * (1 + epss_score * EPSS_BOOST_FACTOR), capped at 10. This reflects that
 * a vulnerability with high exploitability probability is more impactful
 * than one with the same CVSS but low exploitability.
 */
const EPSS_BOOST_FACTOR = 0.5;

/**
 * Clamp a score onto the 0–10 range, mapping NaN to 0.
 *
 * Math.min(Math.max(x, 0), 10) passes NaN straight through (Math.max(NaN, 0)
 * is NaN), so a single NaN input — a JSON-parsed NaN string, an upstream
 * numeric parse gone wrong, or an optional field whose `!= null` guard
 * can't catch NaN — would propagate into every score this function returns
 * and fail every downstream 0–10 invariant. Found live by the property
 * test's NaN counterexample (cli/src/property.test.ts; CI run 36219595599).
 */
export function clampScore(score: number): number {
  if (Number.isNaN(score)) return 0;
  return Math.min(Math.max(score, 0), 10);
}

// ---------------------------------------------------------------------------
// DefaultImpactScorer
// ---------------------------------------------------------------------------

export interface ImpactScoreResult {
  score: number; // 0.0 – 10.0
  inputs: ImpactInputs;
}

export class DefaultImpactScorer {
  score(inputs: ImpactInputs): ImpactScoreResult {
    const base = inputs.cvss_score ?? severityFallbackScore(inputs.severity);

    let score = base * depTypeWeight(inputs.dep_type);

    // Apply EPSS exploitability boost when available (scoring_version 1.1.0).
    // The `Number.isFinite` guard is load-bearing: `!= null` alone is true
    // for NaN, and multiplying by NaN would poison the score — clamp()
    // maps NaN to 0, the same conservative floor as the `unknown` severity
    // fallback, rather than a boosted garbage value. (Number.isFinite does
    // not narrow `number | null`, so both guards are needed.)
    if (inputs.epss_score != null && Number.isFinite(inputs.epss_score)) {
      score *= 1 + inputs.epss_score * EPSS_BOOST_FACTOR;
    }

    if (inputs.is_transitive) {
      score *= UNCONFIRMED_TRANSITIVE_DISCOUNT;
    }

    return { score: clampScore(score), inputs };
  }
}
