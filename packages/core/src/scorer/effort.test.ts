/**
 * DefaultEffortScorer unit tests
 *
 * Exercises every row of the ADR 0006 decision table directly, plus the
 * "has_migration_guide doesn't matter for minor bumps" property and the
 * inputs echo-back contract.
 */

import { describe, expect, it } from "vitest";
import { DefaultEffortScorer } from "./effort.js";
import type { EffortInputs, EffortLabel } from "../db/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseInputs(overrides: Partial<EffortInputs> = {}): EffortInputs {
  return {
    semver_bump: "patch",
    has_migration_guide: false,
    breaking_change_signals: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DefaultEffortScorer", () => {
  const scorer = new DefaultEffortScorer();

  // -------------------------------------------------------------------------
  describe("decision table (ADR 0006)", () => {
    it.each<[EffortInputs, EffortLabel]>([
      [
        { semver_bump: "patch", has_migration_guide: false, breaking_change_signals: [] },
        "trivial",
      ],
      [
        {
          semver_bump: "patch",
          has_migration_guide: false,
          breaking_change_signals: ["removed export"],
        },
        "low",
      ],
      [{ semver_bump: "minor", has_migration_guide: false, breaking_change_signals: [] }, "low"],
      [{ semver_bump: "minor", has_migration_guide: true, breaking_change_signals: [] }, "low"],
      [
        {
          semver_bump: "minor",
          has_migration_guide: false,
          breaking_change_signals: ["deprecated API"],
        },
        "medium",
      ],
      [
        {
          semver_bump: "minor",
          has_migration_guide: true,
          breaking_change_signals: ["deprecated API"],
        },
        "medium",
      ],
      [{ semver_bump: "major", has_migration_guide: true, breaking_change_signals: [] }, "medium"],
      [{ semver_bump: "major", has_migration_guide: false, breaking_change_signals: [] }, "high"],
      [
        { semver_bump: "unknown", has_migration_guide: false, breaking_change_signals: [] },
        "medium",
      ],
      [
        { semver_bump: "unknown", has_migration_guide: true, breaking_change_signals: ["x"] },
        "medium",
      ],
    ])("labels %o as %s", (inputs, expected) => {
      expect(scorer.score(inputs).label).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  it("trusts a patch bump with no breaking signals as trivial", () => {
    const result = scorer.score(baseInputs({ semver_bump: "patch" }));
    expect(result.label).toBe("trivial");
  });

  it("downgrades a patch bump to low when changelog signals disagree with semver", () => {
    const result = scorer.score(
      baseInputs({ semver_bump: "patch", breaking_change_signals: ["renamed config key"] }),
    );
    expect(result.label).toBe("low");
  });

  it("treats unknown semver_bump as medium regardless of other inputs", () => {
    const withGuide = scorer.score(
      baseInputs({
        semver_bump: "unknown",
        has_migration_guide: true,
        breaking_change_signals: ["x"],
      }),
    );
    const withoutGuide = scorer.score(baseInputs({ semver_bump: "unknown" }));
    expect(withGuide.label).toBe("medium");
    expect(withoutGuide.label).toBe("medium");
  });

  it("lowers a major bump from high to medium when a migration guide exists", () => {
    const withoutGuide = scorer.score(
      baseInputs({ semver_bump: "major", has_migration_guide: false }),
    );
    const withGuide = scorer.score(baseInputs({ semver_bump: "major", has_migration_guide: true }));
    expect(withoutGuide.label).toBe("high");
    expect(withGuide.label).toBe("medium");
  });

  // -------------------------------------------------------------------------
  it("echoes back the exact inputs alongside the label", () => {
    const inputs = baseInputs({ semver_bump: "major", has_migration_guide: true });
    const result = scorer.score(inputs);
    expect(result.inputs).toEqual(inputs);
  });
});
