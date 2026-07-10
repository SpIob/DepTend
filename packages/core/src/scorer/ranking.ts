/**
 * Mission ranking
 *
 * Sorts scored missions by composite_score descending. Missions within
 * COMPOSITE_TIE_EPSILON of each other are treated as tied and broken by
 * effort_label ascending (prefer the easier win), then by created_at
 * ascending as a final deterministic tie-breaker.
 *
 * Note: epsilon-based "tied" comparisons aren't strictly transitive
 * (A≈B and B≈C doesn't guarantee A≈C), which can occasionally make
 * comparator-based sorts behave oddly across long chains of near-equal
 * scores. Not worth clustering ties for the 3-repo MVP cap — see ADR 0007.
 *
 * ADR: docs/adr/0006-scoring-algorithm.md
 */

import type { EffortLabel } from "../db/schema.js";

const COMPOSITE_TIE_EPSILON = 0.5;

export interface RankableMission {
  created_at: Date;
  score: {
    composite_score: number;
    effort_label: EffortLabel;
  };
}

function effortRank(label: EffortLabel): number {
  switch (label) {
    case "trivial":
      return 0;
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
    default:
      throw new Error(`Unhandled effort label: ${String(label)}`);
  }
}

/** Returns a new, sorted array — does not mutate the input. */
export function rankMissions<T extends RankableMission>(missions: readonly T[]): T[] {
  return [...missions].sort((a, b) => {
    const diff = a.score.composite_score - b.score.composite_score;

    if (Math.abs(diff) > COMPOSITE_TIE_EPSILON) {
      return -diff; // higher composite_score first
    }

    const effortDiff = effortRank(a.score.effort_label) - effortRank(b.score.effort_label);
    if (effortDiff !== 0) {
      return effortDiff; // easier effort first
    }

    return a.created_at.getTime() - b.created_at.getTime(); // earlier first
  });
}
