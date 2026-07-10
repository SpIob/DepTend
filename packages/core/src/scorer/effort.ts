/**
 * EffortScorer
 *
 * Maps a dependency update's semver bump size, migration guide availability,
 * and changelog breaking-change signals to a categorical effort label.
 * This is a categorical tie-breaker only (see scorer/interface.ts) — it
 * never feeds into the composite score as a number.
 *
 * Decision table (see ADR 0006 for full rationale):
 *
 *   semver_bump | has_migration_guide | breaking_change_signals | label
 *   ------------|----------------------|--------------------------|--------
 *   patch       | —                    | empty                     | trivial
 *   patch       | —                    | non-empty                 | low
 *   minor       | —                    | empty                     | low
 *   minor       | —                    | non-empty                 | medium
 *   major       | true                 | —                         | medium
 *   major       | false                | —                         | high
 *   unknown     | —                    | —                         | medium
 *
 * ADR: docs/adr/0006-scoring-algorithm.md
 */

import type { EffortLabel } from "../db/schema.js";
import type { EffortInputs } from "../db/json-types.js";
import type { EffortScorer, EffortScoreResult } from "./interface.js";

export class DefaultEffortScorer implements EffortScorer {
  score(inputs: EffortInputs): EffortScoreResult {
    const hasBreakingSignals = inputs.breaking_change_signals.length > 0;
    let label: EffortLabel;

    switch (inputs.semver_bump) {
      case "patch":
        // Patch claims no breaking change by semver convention — trust it
        // unless changelog signals disagree.
        label = hasBreakingSignals ? "low" : "trivial";
        break;
      case "minor":
        // has_migration_guide does not change the outcome for a minor bump.
        label = hasBreakingSignals ? "medium" : "low";
        break;
      case "major":
        // A migration guide meaningfully lowers effort even for a major.
        label = inputs.has_migration_guide ? "medium" : "high";
        break;
      case "unknown":
        // Can't assess bump size — moderate default, not optimistic.
        label = "medium";
        break;
      default:
        throw new Error(`Unhandled semver_bump: ${String(inputs.semver_bump)}`);
    }

    return { label, inputs };
  }
}
