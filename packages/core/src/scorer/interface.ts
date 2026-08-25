/**
 * Scorer interface
 *
 * Scoring algorithm contracts. Each sub-scorer (impact, effort, ecosystem
 * value) must implement its interface and be covered by unit tests before
 * use in production.
 *
 * Scoring weights v1.0.0:
 *   composite = (impact * 0.60) + (ecosystem_value * 0.40)
 *   effort_label is a categorical tie-breaker, not a numeric multiplier.
 *
 * ADR: docs/adr/0006-scoring-algorithm.md
 */

import type { EffortLabel } from "../db/schema.js";
import type { EffortInputs, EcosystemValueInputs, ImpactInputs } from "../db/json-types.js";

export interface ImpactScoreResult {
  score: number; // 0.0 – 10.0
  inputs: ImpactInputs;
}

export interface EffortScoreResult {
  label: EffortLabel;
  inputs: EffortInputs;
}

export interface EcosystemValueScoreResult {
  score: number; // 0.0 – 10.0
  inputs: EcosystemValueInputs;
}

// CompositeScoreResult (a flattened mission_scores shape) was removed —
// MissionScoreComputation in mission-scorer.ts is the real, used shape.

export interface ImpactScorer {
  score(inputs: ImpactInputs): ImpactScoreResult;
}

export interface EffortScorer {
  score(inputs: EffortInputs): EffortScoreResult;
}

export interface EcosystemValueScorer {
  score(inputs: EcosystemValueInputs): EcosystemValueScoreResult;
}
