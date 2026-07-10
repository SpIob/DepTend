/**
 * DefaultImpactScorer unit tests
 *
 * Covers: CVSS-present path, severity-fallback path (all five levels),
 * dep_type weighting (all four values), the unconfirmed-transitivity
 * discount, clamping at the top of the range, and that days_since_advisory
 * is echoed back but never affects the score (ADR 0006).
 */

import { describe, expect, it } from "vitest";
import { DefaultImpactScorer } from "./impact.js";
import type { DepType, Severity } from "../db/schema.js";
import type { ImpactInputs } from "../db/json-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseInputs(overrides: Partial<ImpactInputs> = {}): ImpactInputs {
  return {
    cvss_score: null,
    severity: "medium",
    is_transitive: false,
    dep_type: "production",
    days_since_advisory: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DefaultImpactScorer", () => {
  const scorer = new DefaultImpactScorer();

  // -------------------------------------------------------------------------
  describe("CVSS present", () => {
    it("uses cvss_score directly as the base when present", () => {
      const result = scorer.score(baseInputs({ cvss_score: 8.2, severity: "unknown" }));
      // production weight is 1.0, so base passes through unchanged
      expect(result.score).toBeCloseTo(8.2, 5);
    });

    it("ignores severity entirely when cvss_score is present", () => {
      const withLowSeverity = scorer.score(
        baseInputs({ cvss_score: 6.0, severity: "low", dep_type: "production" }),
      );
      const withCriticalSeverity = scorer.score(
        baseInputs({ cvss_score: 6.0, severity: "critical", dep_type: "production" }),
      );
      expect(withLowSeverity.score).toBeCloseTo(withCriticalSeverity.score, 5);
    });
  });

  // -------------------------------------------------------------------------
  describe("severity fallback (cvss_score null)", () => {
    it.each<[Severity, number]>([
      ["critical", 9.0],
      ["high", 7.0],
      ["medium", 5.0],
      ["low", 2.5],
      ["unknown", 1.0],
    ])("maps severity %s to base score %f", (severity, expected) => {
      const result = scorer.score(
        baseInputs({ cvss_score: null, severity, dep_type: "production" }),
      );
      expect(result.score).toBeCloseTo(expected, 5);
    });

    it("gives unknown severity the conservative floor, not a middle value", () => {
      const unknown = scorer.score(baseInputs({ severity: "unknown", dep_type: "production" }));
      const low = scorer.score(baseInputs({ severity: "low", dep_type: "production" }));
      expect(unknown.score).toBeLessThan(low.score);
    });
  });

  // -------------------------------------------------------------------------
  describe("dep_type weighting", () => {
    it.each<[DepType, number]>([
      ["production", 1.0],
      ["peer", 0.9],
      ["optional", 0.6],
      ["development", 0.4],
    ])("applies %s weight of %f to the CVSS base", (depType, weight) => {
      const result = scorer.score(baseInputs({ cvss_score: 10, dep_type: depType }));
      expect(result.score).toBeCloseTo(10 * weight, 5);
    });
  });

  // -------------------------------------------------------------------------
  describe("transitivity discount", () => {
    it("applies a 0.9x discount when is_transitive is true", () => {
      const direct = scorer.score(
        baseInputs({ cvss_score: 8.0, dep_type: "production", is_transitive: false }),
      );
      const transitive = scorer.score(
        baseInputs({ cvss_score: 8.0, dep_type: "production", is_transitive: true }),
      );
      expect(transitive.score).toBeCloseTo(direct.score * 0.9, 5);
    });

    it("does not discount when is_transitive is false", () => {
      const result = scorer.score(
        baseInputs({ cvss_score: 8.0, dep_type: "production", is_transitive: false }),
      );
      expect(result.score).toBeCloseTo(8.0, 5);
    });
  });

  // -------------------------------------------------------------------------
  describe("clamping", () => {
    it("clamps to 10 when cvss_score is already at the maximum", () => {
      const result = scorer.score(baseInputs({ cvss_score: 10, dep_type: "production" }));
      expect(result.score).toBeLessThanOrEqual(10);
      expect(result.score).toBeCloseTo(10, 5);
    });

    it("never returns a negative score", () => {
      const result = scorer.score(
        baseInputs({
          cvss_score: 0,
          severity: "unknown",
          dep_type: "development",
          is_transitive: true,
        }),
      );
      expect(result.score).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("days_since_advisory", () => {
    it("does not affect the score (no recency modifier in v1 — ADR 0006)", () => {
      const recent = scorer.score(baseInputs({ cvss_score: 7.0, days_since_advisory: 1 }));
      const old = scorer.score(baseInputs({ cvss_score: 7.0, days_since_advisory: 900 }));
      expect(recent.score).toBeCloseTo(old.score, 5);
    });

    it("is echoed back unchanged in the result's inputs", () => {
      const inputs = baseInputs({ days_since_advisory: 42 });
      const result = scorer.score(inputs);
      expect(result.inputs.days_since_advisory).toBe(42);
    });
  });

  // -------------------------------------------------------------------------
  it("echoes back the exact inputs object contents alongside the score", () => {
    const inputs = baseInputs({ cvss_score: 5.5, severity: "high", dep_type: "peer" });
    const result = scorer.score(inputs);
    expect(result.inputs).toEqual(inputs);
  });
});
