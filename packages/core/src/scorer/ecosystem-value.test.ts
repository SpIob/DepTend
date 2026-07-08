/**
 * DefaultEcosystemValueScorer unit tests
 *
 * Covers: the log-scale components in isolation (zero, mid-range, and at
 * the ceiling), the renormalized formula used when downstream_dependents
 * is null vs. the full formula when it's present, monotonicity, and
 * defensive clamping. Expected values are computed directly from the
 * documented formula (ADR 0006) rather than approximated, so a regression
 * in the math — not just the code path taken — will fail these.
 */

import { describe, expect, it } from "vitest";
import { DefaultEcosystemValueScorer } from "./ecosystem-value.js";
import type { EcosystemValueInputs } from "../db/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseInputs(overrides: Partial<EcosystemValueInputs> = {}): EcosystemValueInputs {
  return {
    repo_stars: 0,
    open_issues_count: 0,
    downstream_dependents: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DefaultEcosystemValueScorer", () => {
  const scorer = new DefaultEcosystemValueScorer();

  // -------------------------------------------------------------------------
  describe("zero-signal repos", () => {
    it("scores 0 when stars, issues, and downstream_dependents are all zero/null", () => {
      const result = scorer.score(baseInputs());
      expect(result.score).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("downstream_dependents present — full weighting", () => {
    it("matches the documented formula (0.50 stars + 0.35 downstream + 0.15 engagement)", () => {
      const result = scorer.score(
        baseInputs({ repo_stars: 1000, open_issues_count: 100, downstream_dependents: 500 }),
      );
      expect(result.score).toBeCloseTo(6.364952774504479, 9);
    });
  });

  // -------------------------------------------------------------------------
  describe("downstream_dependents null — renormalized weighting", () => {
    it("matches the documented renormalized formula (0.75 stars + 0.25 engagement)", () => {
      const result = scorer.score(
        baseInputs({ repo_stars: 1000, open_issues_count: 100, downstream_dependents: null }),
      );
      expect(result.score).toBeCloseTo(6.170918927704514, 9);
    });

    it("never treats a null downstream_dependents as if it were zero", () => {
      const withNull = scorer.score(
        baseInputs({ repo_stars: 1000, open_issues_count: 100, downstream_dependents: null }),
      );
      // If null were silently treated as 0 downstream dependents, the
      // downstream component would be included at weight 0.35 with value 0,
      // dragging the score down to stars*0.5 + issues*0.15 — lower than the
      // correctly-renormalized result computed above.
      expect(withNull.score).toBeGreaterThan(6.000868154958638 * 0.5 + 6.6810712459421415 * 0.15);
    });
  });

  // -------------------------------------------------------------------------
  describe("log-scale ceilings", () => {
    it("reaches (and clamps at) 10 when every component is at or beyond its ceiling", () => {
      const result = scorer.score(
        baseInputs({
          repo_stars: 100_000,
          open_issues_count: 1_000,
          downstream_dependents: 10_000,
        }),
      );
      expect(result.score).toBeLessThanOrEqual(10);
      expect(result.score).toBeCloseTo(10, 4);
    });

    it("does not exceed 10 for star counts far beyond the ceiling", () => {
      const result = scorer.score(baseInputs({ repo_stars: 5_000_000 }));
      expect(result.score).toBeLessThanOrEqual(10);
    });
  });

  // -------------------------------------------------------------------------
  describe("monotonicity", () => {
    it("scores strictly higher for more stars, all else equal", () => {
      const fewer = scorer.score(baseInputs({ repo_stars: 100 }));
      const more = scorer.score(baseInputs({ repo_stars: 10_000 }));
      expect(more.score).toBeGreaterThan(fewer.score);
    });

    it("scores strictly higher when downstream_dependents grows, all else equal", () => {
      const fewer = scorer.score(baseInputs({ repo_stars: 500, downstream_dependents: 10 }));
      const more = scorer.score(baseInputs({ repo_stars: 500, downstream_dependents: 5000 }));
      expect(more.score).toBeGreaterThan(fewer.score);
    });
  });

  // -------------------------------------------------------------------------
  describe("defensive clamping", () => {
    it("floors a (defensively unexpected) negative count at 0 rather than throwing", () => {
      const result = scorer.score(baseInputs({ repo_stars: -50 }));
      expect(result.score).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  it("echoes back the exact inputs alongside the score", () => {
    const inputs = baseInputs({ repo_stars: 42, open_issues_count: 7, downstream_dependents: 3 });
    const result = scorer.score(inputs);
    expect(result.inputs).toEqual(inputs);
  });
});
