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
import type { ImpactScorer, ImpactScoreResult } from "./interface.js";

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
      throw new Error(`Unhandled dep_type: ${String(depType)}`);
  }
}

/**
 * Applied whenever is_transitive is true. Lock file parsing hasn't landed as
 * of scoring_version 1.0.0 (deferred — see Project Instructions), so
 * is_transitive can currently only ever be an inference, never a
 * lock-file-confirmed fact. This discount reflects that reduced certainty,
 * not a claim that transitive vulnerabilities matter less. Revisit this
 * scorer once confirmed transitivity is possible (ADR 0006).
 */
const UNCONFIRMED_TRANSITIVE_DISCOUNT = 0.9;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ---------------------------------------------------------------------------
// DefaultImpactScorer
// ---------------------------------------------------------------------------

export class DefaultImpactScorer implements ImpactScorer {
  score(inputs: ImpactInputs): ImpactScoreResult {
    const base = inputs.cvss_score ?? severityFallbackScore(inputs.severity);

    let score = base * depTypeWeight(inputs.dep_type);

    if (inputs.is_transitive) {
      score *= UNCONFIRMED_TRANSITIVE_DISCOUNT;
    }

    return { score: clamp(score, 0, 10), inputs };
  }
}
