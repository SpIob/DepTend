/**
 * EcosystemValueScorer
 *
 * Computes a 0.0–10.0 ecosystem value score: how much the broader ecosystem
 * benefits from this repo's mission being resolved. Stars and issue counts
 * are heavily right-skewed, so each component is log-scaled against a soft
 * ceiling rather than scaled linearly — a linear scale would put nearly
 * every repo except mega-projects near zero.
 *
 * downstream_dependents has no data source as of scoring_version 1.0.0 (see
 * ADR 0006) and is null for every repo today. When null, that component is
 * excluded and the remaining weights are renormalized — never defaulted to
 * zero, which would understate value for exactly the repos with the least
 * data available.
 *
 * ADR: docs/adr/0006-scoring-algorithm.md
 */

import type { EcosystemValueInputs } from "../db/types.js";
import type { EcosystemValueScorer, EcosystemValueScoreResult } from "./interface.js";

// ---------------------------------------------------------------------------
// Ceilings and weights (scoring_version 1.0.0 — see ADR 0006)
// ---------------------------------------------------------------------------

const STARS_CEILING = 100_000;
const ENGAGEMENT_CEILING = 1_000;
const DOWNSTREAM_CEILING = 10_000;

const WEIGHTS_WITH_DOWNSTREAM = { stars: 0.5, downstream: 0.35, engagement: 0.15 };
const WEIGHTS_WITHOUT_DOWNSTREAM = { stars: 0.75, engagement: 0.25 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Log-scale a non-negative count against a soft ceiling, onto a 0–10 range. */
function logComponent(count: number, ceiling: number): number {
  const nonNegative = Math.max(count, 0);
  const scaled = (Math.log10(nonNegative + 1) / Math.log10(ceiling)) * 10;
  return clamp(scaled, 0, 10);
}

// ---------------------------------------------------------------------------
// DefaultEcosystemValueScorer
// ---------------------------------------------------------------------------

export class DefaultEcosystemValueScorer implements EcosystemValueScorer {
  score(inputs: EcosystemValueInputs): EcosystemValueScoreResult {
    const starsComponent = logComponent(inputs.repo_stars, STARS_CEILING);
    const engagementComponent = logComponent(inputs.open_issues_count, ENGAGEMENT_CEILING);

    let score: number;

    if (inputs.downstream_dependents !== null) {
      const downstreamComponent = logComponent(inputs.downstream_dependents, DOWNSTREAM_CEILING);
      score =
        starsComponent * WEIGHTS_WITH_DOWNSTREAM.stars +
        downstreamComponent * WEIGHTS_WITH_DOWNSTREAM.downstream +
        engagementComponent * WEIGHTS_WITH_DOWNSTREAM.engagement;
    } else {
      score =
        starsComponent * WEIGHTS_WITHOUT_DOWNSTREAM.stars +
        engagementComponent * WEIGHTS_WITHOUT_DOWNSTREAM.engagement;
    }

    return { score: clamp(score, 0, 10), inputs };
  }
}
