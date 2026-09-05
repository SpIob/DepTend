/**
 * Mission scoring — composite orchestration
 *
 * Imports input mappers, confidence derivation, and individual scorers,
 * then combines their results into a single composite score.
 *
 * Phase 2 generates vulnerability_fix missions only — see ADR 0007 for why
 * dep_update / maintenance / license_issue are deferred.
 *
 * ADR: docs/adr/0007-mission-score-writing.md (mapping, confidence, scope)
 *      docs/adr/0006-scoring-algorithm.md (formulas)
 *      docs/adr/0029-breaking-change-signals.md (effortSignals, Step 4)
 *      docs/adr/0032-downstream-dependents.md (downstreamDependents)
 */

import type { Dependency, Advisory, Repo, EffortLabel, ScoreConfidence } from "../db/schema.js";
import type {
  ConfidenceFlags,
  EffortInputs,
  EcosystemValueInputs,
  ImpactInputs,
} from "../db/json-types.js";
import type { EffortSignals } from "../ingestor/changelog-signals.js";
import { DefaultImpactScorer } from "./impact.js";
import { DefaultEffortScorer } from "./effort.js";
import { DefaultEcosystemValueScorer } from "./ecosystem-value.js";
import {
  buildImpactInputs,
  buildEffortInputs,
  buildEcosystemValueInputs,
} from "./input-mappers.js";
import { deriveConfidenceFlags, deriveConfidence, buildConfidenceNotes } from "./confidence.js";
import { extractVersionFloor } from "./bump-inference.js";

// Re-export for backward compatibility (tests and any external callers)
export {
  buildImpactInputs,
  buildEffortInputs,
  buildEcosystemValueInputs,
  deriveConfidenceFlags,
  deriveConfidence,
  buildConfidenceNotes,
  extractVersionFloor,
};

export const SCORING_VERSION = "1.1.0";

/**
 * A dependency confirmed (via dependency_advisories.is_affected) to be
 * affected by the given advisory, plus the repo it belongs to. This
 * function does not re-validate that match — the caller is responsible for
 * only passing already-confirmed pairs.
 */
export interface MissionScoringContext {
  dependency: Dependency;
  advisory: Advisory;
  repo: Repo;
  /**
   * Prefetched breaking-change/migration-guide signals for this
   * dependency's own upstream repo (ADR 0029) — undefined means "the
   * caller never attempted this," treated identically to a resolved
   * `source_available: false`. Always undefined before Step 5 wires the
   * writer.ts prefetch in; buildEffortInputs()/deriveConfidenceFlags()
   * both already handle its absence, so this addition doesn't break any
   * existing caller (CLI's analyze.ts, scorer/writer.test.ts fixtures)
   * before that step lands.
   */
  effortSignals?: EffortSignals;
  /**
   * Prefetched downstream-dependent count for the *analyzed repo's* own
   * published package(s) (ADR 0032) — undefined means "the caller never
   * attempted it," or attempted and couldn't resolve a published package
   * (no key, unknown to libraries.io, fetch failed). Both keep
   * downstream_dependents null and downstream_dependents_unavailable set,
   * identical to pre-ADR-0032 behavior. A present value — including a
   * genuine 0 — is real, checked data: the flag clears and the ecosystem
   * value scorer's with-downstream weighting applies.
   */
  downstreamDependents?: number;
}

export interface MissionScoreComputation {
  impact_score: number;
  ecosystem_value_score: number;
  composite_score: number;
  effort_label: EffortLabel;
  impact_inputs: ImpactInputs;
  ecosystem_value_inputs: EcosystemValueInputs;
  effort_inputs: EffortInputs;
  confidence: ScoreConfidence;
  confidence_notes: string[];
  confidence_flags: ConfidenceFlags;
  scoring_version: string;
}

const impactScorer = new DefaultImpactScorer();
const effortScorer = new DefaultEffortScorer();
const ecosystemValueScorer = new DefaultEcosystemValueScorer();

/**
 * Computes a full mission score from a confirmed (dependency, advisory,
 * repo) context. Pure — performs no I/O. Shaped to spread directly into a
 * MissionScoreInsert alongside a mission_id once the DB-writer step exists.
 */
export function computeMissionScore(ctx: MissionScoringContext): MissionScoreComputation {
  const impactInputs = buildImpactInputs(ctx);
  const effortInputs = buildEffortInputs(ctx);
  const ecosystemValueInputs = buildEcosystemValueInputs(ctx);
  const confidenceFlags = deriveConfidenceFlags(ctx);

  const impactResult = impactScorer.score(impactInputs);
  const effortResult = effortScorer.score(effortInputs);
  const ecosystemValueResult = ecosystemValueScorer.score(ecosystemValueInputs);

  const composite_score = Math.min(
    Math.max(impactResult.score * 0.6 + ecosystemValueResult.score * 0.4, 0),
    10,
  );

  return {
    impact_score: impactResult.score,
    ecosystem_value_score: ecosystemValueResult.score,
    composite_score,
    effort_label: effortResult.label,
    impact_inputs: impactResult.inputs,
    ecosystem_value_inputs: ecosystemValueResult.inputs,
    effort_inputs: effortResult.inputs,
    confidence: deriveConfidence(confidenceFlags),
    confidence_notes: buildConfidenceNotes(confidenceFlags),
    confidence_flags: confidenceFlags,
    scoring_version: SCORING_VERSION,
  };
}
