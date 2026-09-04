/**
 * Mission scoring unit tests
 *
 * Covers: input mapping from Dependency/Advisory/Repo rows (including the
 * semver_bump inference edge cases from ADR 0007 §4), confidence flag
 * derivation and its "always low right now" consequence, confidence notes,
 * and the end-to-end composite computation.
 */

import { describe, expect, it } from "vitest";
import {
  buildImpactInputs,
  buildEffortInputs,
  buildEcosystemValueInputs,
  deriveConfidenceFlags,
  deriveConfidence,
  buildConfidenceNotes,
  computeMissionScore,
  extractVersionFloor,
  SCORING_VERSION,
  type MissionScoringContext,
} from "./mission-scorer.js";
import { makeDependency, makeAdvisory, makeRepo, makeContext } from "./test-fixtures.js";
import type { Dependency } from "../db/schema.js";

// ---------------------------------------------------------------------------
// buildImpactInputs
// ---------------------------------------------------------------------------

describe("buildImpactInputs", () => {
  it("maps cvss_score, severity, and dep_type directly from the advisory/dependency", () => {
    const inputs = buildImpactInputs(
      makeContext({
        advisory: makeAdvisory({ cvssScore: 8.1, severity: "critical" }),
        dependency: makeDependency({ depType: "peer" }),
      }),
    );
    expect(inputs.cvss_score).toBe(8.1);
    expect(inputs.severity).toBe("critical");
    expect(inputs.dep_type).toBe("peer");
  });

  it("is always is_transitive: false (Phase 1/2 only ingests direct deps — ADR 0007 §2)", () => {
    const inputs = buildImpactInputs(makeContext());
    expect(inputs.is_transitive).toBe(false);
  });

  it("computes days_since_advisory from published_at", () => {
    const publishedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
    const inputs = buildImpactInputs(makeContext({ advisory: makeAdvisory({ publishedAt }) }));
    expect(inputs.days_since_advisory).toBe(10);
  });

  it("returns null days_since_advisory when published_at is null", () => {
    const inputs = buildImpactInputs(
      makeContext({ advisory: makeAdvisory({ publishedAt: null }) }),
    );
    expect(inputs.days_since_advisory).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildEffortInputs — semver_bump inference (ADR 0007 §4)
// ---------------------------------------------------------------------------

describe("buildEffortInputs", () => {
  it("infers a patch bump from a caret range to a nearby fixed_version", () => {
    const inputs = buildEffortInputs(
      makeContext({
        dependency: makeDependency({ versionSpec: "^1.2.3" }),
        advisory: makeAdvisory({ fixedVersion: "1.2.4" }),
      }),
    );
    expect(inputs.semver_bump).toBe("patch");
  });

  it("infers a minor bump", () => {
    const inputs = buildEffortInputs(
      makeContext({
        dependency: makeDependency({ versionSpec: "^1.2.3" }),
        advisory: makeAdvisory({ fixedVersion: "1.3.0" }),
      }),
    );
    expect(inputs.semver_bump).toBe("minor");
  });

  it("infers a major bump", () => {
    const inputs = buildEffortInputs(
      makeContext({
        dependency: makeDependency({ versionSpec: "^1.2.3" }),
        advisory: makeAdvisory({ fixedVersion: "2.0.0" }),
      }),
    );
    expect(inputs.semver_bump).toBe("major");
  });

  it("falls back to dependency.latest_version when the advisory has no fixed_version", () => {
    const inputs = buildEffortInputs(
      makeContext({
        dependency: makeDependency({ versionSpec: "^1.2.3", latestVersion: "1.3.0" }),
        advisory: makeAdvisory({ fixedVersion: null }),
      }),
    );
    expect(inputs.semver_bump).toBe("minor");
  });

  it("returns unknown when neither fixed_version nor latest_version is available", () => {
    const inputs = buildEffortInputs(
      makeContext({
        dependency: makeDependency({ latestVersion: null }),
        advisory: makeAdvisory({ fixedVersion: null }),
      }),
    );
    expect(inputs.semver_bump).toBe("unknown");
  });

  it("returns unknown for a wildcard range rather than fabricating a major bump", () => {
    const inputs = buildEffortInputs(
      makeContext({ dependency: makeDependency({ versionSpec: "*" }) }),
    );
    expect(inputs.semver_bump).toBe("unknown");
  });

  it("returns unknown for an empty range string", () => {
    const inputs = buildEffortInputs(
      makeContext({ dependency: makeDependency({ versionSpec: "" }) }),
    );
    expect(inputs.semver_bump).toBe("unknown");
  });

  it.each(["latest", "next", "workspace:*", "file:../foo", "git+https://github.com/a/b.git"])(
    "returns unknown rather than throwing for the non-range spec %s",
    (versionSpec) => {
      expect(() =>
        buildEffortInputs(makeContext({ dependency: makeDependency({ versionSpec }) })),
      ).not.toThrow();
      const inputs = buildEffortInputs(
        makeContext({ dependency: makeDependency({ versionSpec }) }),
      );
      expect(inputs.semver_bump).toBe("unknown");
    },
  );

  it("returns unknown when the target version is not coercible to semver", () => {
    const inputs = buildEffortInputs(
      makeContext({
        dependency: makeDependency({ versionSpec: "^1.2.3" }),
        advisory: makeAdvisory({ fixedVersion: "not-a-version" }),
      }),
    );
    expect(inputs.semver_bump).toBe("unknown");
  });

  it("defaults to has_migration_guide: false and breaking_change_signals: [] when effortSignals is absent (ADR 0007 §5 / ADR 0029)", () => {
    const inputs = buildEffortInputs(makeContext());
    expect(inputs.has_migration_guide).toBe(false);
    expect(inputs.breaking_change_signals).toEqual([]);
  });

  it("uses prefetched effortSignals when present (ADR 0029)", () => {
    const inputs = buildEffortInputs(
      makeContext({
        effortSignals: {
          has_migration_guide: true,
          breaking_change_signals: ["removed the old API"],
          source_available: true,
        },
      }),
    );
    expect(inputs.has_migration_guide).toBe(true);
    expect(inputs.breaking_change_signals).toEqual(["removed the old API"]);
  });

  it("falls back to false/[] when effortSignals resolved but found nothing (ADR 0029)", () => {
    const inputs = buildEffortInputs(
      makeContext({
        effortSignals: {
          has_migration_guide: false,
          breaking_change_signals: [],
          source_available: true,
        },
      }),
    );
    expect(inputs.has_migration_guide).toBe(false);
    expect(inputs.breaking_change_signals).toEqual([]);
  });

  it("falls back to false/[] when effortSignals reflects an unavailable source (ADR 0029)", () => {
    const inputs = buildEffortInputs(
      makeContext({
        effortSignals: {
          has_migration_guide: false,
          breaking_change_signals: [],
          source_available: false,
        },
      }),
    );
    expect(inputs.has_migration_guide).toBe(false);
    expect(inputs.breaking_change_signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildEffortInputs — PEP 440 bump inference for PyPI (ADR 0022, Decision 3)
//
// Mirrors the semver block above test-for-test where the concepts line up,
// plus a few PEP-440-specific cases (epoch, "~=", multi-clause floors) that
// have no direct semver equivalent.
// ---------------------------------------------------------------------------

describe("buildEffortInputs — PyPI / PEP 440", () => {
  function pypiContext(
    versionSpec: string,
    fixedVersion: string | null,
    overrides: Partial<Dependency> = {},
  ): MissionScoringContext {
    return makeContext({
      dependency: makeDependency({ ecosystem: "pypi", versionSpec, ...overrides }),
      advisory: makeAdvisory({ fixedVersion }),
    });
  }

  it("infers a patch bump from a >= floor to a nearby fixed_version", () => {
    const inputs = buildEffortInputs(pypiContext(">=1.2.3", "1.2.4"));
    expect(inputs.semver_bump).toBe("patch");
  });

  it("infers a minor bump", () => {
    const inputs = buildEffortInputs(pypiContext(">=1.2.3", "1.3.0"));
    expect(inputs.semver_bump).toBe("minor");
  });

  it("infers a major bump", () => {
    const inputs = buildEffortInputs(pypiContext(">=1.2.3", "2.0.0"));
    expect(inputs.semver_bump).toBe("major");
  });

  it("infers a floor from the compatible-release operator ~=", () => {
    const inputs = buildEffortInputs(pypiContext("~=1.4.2", "1.4.9"));
    expect(inputs.semver_bump).toBe("patch");
  });

  it("falls back to dependency.latest_version when the advisory has no fixed_version", () => {
    const inputs = buildEffortInputs(pypiContext(">=1.2.3", null, { latestVersion: "1.3.0" }));
    expect(inputs.semver_bump).toBe("minor");
  });

  it("returns unknown when neither fixed_version nor latest_version is available", () => {
    const inputs = buildEffortInputs(pypiContext(">=1.2.3", null, { latestVersion: null }));
    expect(inputs.semver_bump).toBe("unknown");
  });

  it("returns unknown for an unconstrained dependency ('*', set by pypi-parse.ts for a bare PEP 508 name)", () => {
    const inputs = buildEffortInputs(pypiContext("*", "2.0.0"));
    expect(inputs.semver_bump).toBe("unknown");
  });

  it("returns unknown for an empty specifier string", () => {
    const inputs = buildEffortInputs(pypiContext("", "2.0.0"));
    expect(inputs.semver_bump).toBe("unknown");
  });

  it.each(["not-a-version-spec-at-all", "some garbage !!! text"])(
    "returns unknown rather than throwing for an unparseable spec %s",
    (versionSpec) => {
      expect(() => buildEffortInputs(pypiContext(versionSpec, "2.0.0"))).not.toThrow();
      const inputs = buildEffortInputs(pypiContext(versionSpec, "2.0.0"));
      expect(inputs.semver_bump).toBe("unknown");
    },
  );

  it("returns unknown when the target version is not a valid PEP 440 version", () => {
    const inputs = buildEffortInputs(pypiContext(">=1.2.3", "not-a-version"));
    expect(inputs.semver_bump).toBe("unknown");
  });

  it("treats a wildcard equality clause (==1.4.*) as no usable floor -> unknown", () => {
    const inputs = buildEffortInputs(pypiContext("==1.4.*", "2.0.0"));
    expect(inputs.semver_bump).toBe("unknown");
  });

  it("ignores exclusion clauses (!=) when looking for a floor", () => {
    // No >=/==/~=/> clause at all — just an exclusion — so there's no
    // usable floor even though the specifier itself is syntactically valid.
    const inputs = buildEffortInputs(pypiContext("!=1.5.0", "2.0.0"));
    expect(inputs.semver_bump).toBe("unknown");
  });

  it("picks the most restrictive of multiple floor-establishing clauses", () => {
    // >=1.0 and >=2.0 both establish a floor; 2.0 is more restrictive.
    // Target 2.0.1 is a patch bump from 2.0, not a major bump from 1.0.
    const inputs = buildEffortInputs(pypiContext(">=1.0,>=2.0", "2.0.1"));
    expect(inputs.semver_bump).toBe("patch");
  });

  it("treats an epoch change as a major bump even when release segments look identical", () => {
    // PEP 440 epochs are the highest-precedence ordering component — a
    // change here is a bigger discontinuity than a release-segment
    // comparison alone would ever reveal.
    const inputs = buildEffortInputs(pypiContext(">=1.0.0", "2!1.0.0"));
    expect(inputs.semver_bump).toBe("major");
  });

  it("treats identical release segments differing only in a post-release suffix as patch", () => {
    const inputs = buildEffortInputs(pypiContext(">=1.0.0", "1.0.0.post1"));
    expect(inputs.semver_bump).toBe("patch");
  });

  it("still uses semver (not PEP 440) for an npm dependency, even with pep440 available", () => {
    const inputs = buildEffortInputs(
      makeContext({
        dependency: makeDependency({ ecosystem: "npm", versionSpec: "^1.2.3" }),
        advisory: makeAdvisory({ fixedVersion: "2.0.0" }),
      }),
    );
    // A caret range is meaningless PEP 440 syntax — if this accidentally
    // routed through inferPep440Bump instead, validRange("^1.2.3") would
    // reject it and this would come back "unknown" instead of "major".
    expect(inputs.semver_bump).toBe("major");
  });
});

// ---------------------------------------------------------------------------
// buildEffortInputs — Go (ADR 0024, Decision 3)
//
// No new bump-inference function exists for Go — BUMP_INFERENCE_BY_ECOSYSTEM
// routes "go" at the literal same inferSemverBump() function "npm" uses,
// since Go module versions are real, toolchain-enforced SemVer. These tests
// confirm that routing actually happens (not just that inferSemverBump
// itself works — that's already covered by the semver block above).
// ---------------------------------------------------------------------------

describe("buildEffortInputs — Go", () => {
  function goContext(
    versionSpec: string,
    fixedVersion: string | null,
    overrides: Partial<Dependency> = {},
  ): MissionScoringContext {
    return makeContext({
      dependency: makeDependency({ ecosystem: "go", versionSpec, ...overrides }),
      advisory: makeAdvisory({ fixedVersion }),
    });
  }

  it("infers a patch bump for a Go module using v-prefixed versions", () => {
    const inputs = buildEffortInputs(goContext("v1.2.3", "v1.2.4"));
    expect(inputs.semver_bump).toBe("patch");
  });

  it("infers a minor bump for a Go module using v-prefixed versions", () => {
    const inputs = buildEffortInputs(goContext("v1.2.3", "v1.3.0"));
    expect(inputs.semver_bump).toBe("minor");
  });

  it("infers a major bump for a Go module using v-prefixed versions", () => {
    const inputs = buildEffortInputs(goContext("v1.2.3", "v2.0.0"));
    expect(inputs.semver_bump).toBe("major");
  });

  it("handles a Go pseudo-version as the version_spec without throwing", () => {
    expect(() =>
      buildEffortInputs(goContext("v0.0.0-20210101000000-abcdef123456", "v1.0.0")),
    ).not.toThrow();
  });

  it("returns unknown when targetVersion is null (no fixed_version, no latestVersion)", () => {
    const inputs = buildEffortInputs(goContext("v1.2.3", null, { latestVersion: null }));
    expect(inputs.semver_bump).toBe("unknown");
  });

  it("does not route a Go dependency through inferPep440Bump", () => {
    // "v1.2.3" is not valid PEP 440 syntax — if this accidentally routed
    // through inferPep440Bump, pep440's validRange("v1.2.3") would reject
    // it and this would come back "unknown" instead of "patch".
    const inputs = buildEffortInputs(goContext("v1.2.3", "v1.2.4"));
    expect(inputs.semver_bump).toBe("patch");
  });
});

// ---------------------------------------------------------------------------
// buildEcosystemValueInputs
// ---------------------------------------------------------------------------

describe("buildEcosystemValueInputs", () => {
  it("maps repo_stars and open_issues_count directly, and downstream_dependents as null", () => {
    const inputs = buildEcosystemValueInputs(
      makeContext({ repo: makeRepo({ stars: 4200, openIssuesCount: 17 }) }),
    );
    expect(inputs.repo_stars).toBe(4200);
    expect(inputs.open_issues_count).toBe(17);
    expect(inputs.downstream_dependents).toBeNull();
  });

  it("carries a prefetched downstream_dependents count through (ADR 0032)", () => {
    const inputs = buildEcosystemValueInputs(makeContext({ downstreamDependents: 4320 }));
    expect(inputs.downstream_dependents).toBe(4320);
  });

  it("carries a genuine 0 through as 0, not null (ADR 0032)", () => {
    const inputs = buildEcosystemValueInputs(makeContext({ downstreamDependents: 0 }));
    expect(inputs.downstream_dependents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deriveConfidenceFlags
// ---------------------------------------------------------------------------

describe("extractVersionFloor (ADR 0029)", () => {
  it("returns the same floor npm's own bump inference uses, for npm", () => {
    expect(extractVersionFloor("npm", "^4.17.0")).toBe("4.17.0");
  });

  it("returns the same floor for go (real SemVer, same function as npm)", () => {
    expect(extractVersionFloor("go", "^1.8.0")).toBe("1.8.0");
  });

  it('returns null for an unconstrained npm range ("*")', () => {
    expect(extractVersionFloor("npm", "*")).toBeNull();
  });

  it("returns null for an invalid npm range", () => {
    expect(extractVersionFloor("npm", "not-a-range")).toBeNull();
  });

  it("returns the same floor pep440's own bump inference uses, for pypi", () => {
    expect(extractVersionFloor("pypi", ">=2.25,<3")).toBe("2.25");
  });

  it('returns null for an unconstrained pypi specifier ("*")', () => {
    expect(extractVersionFloor("pypi", "*")).toBeNull();
  });

  it("returns null for a pypi specifier with no lower-bound clause", () => {
    expect(extractVersionFloor("pypi", "<5.4")).toBeNull();
  });
});

describe("deriveConfidenceFlags", () => {
  it("sets no_lock_file from dependency.resolved_version, not lock_file_present (ADR 0007 §3)", () => {
    const withResolved = deriveConfidenceFlags(
      makeContext({ dependency: makeDependency({ resolvedVersion: "1.2.3" }) }),
    );
    const withoutResolved = deriveConfidenceFlags(
      makeContext({ dependency: makeDependency({ resolvedVersion: null }) }),
    );
    expect(withResolved.no_lock_file).toBeUndefined();
    expect(withoutResolved.no_lock_file).toBe(true);
  });

  it("sets cvss_score_missing when the advisory has no CVSS score", () => {
    const flags = deriveConfidenceFlags(
      makeContext({ advisory: makeAdvisory({ cvssScore: null }) }),
    );
    expect(flags.cvss_score_missing).toBe(true);
  });

  it("sets fixed_version_unknown when the advisory has no fixed version", () => {
    const flags = deriveConfidenceFlags(
      makeContext({ advisory: makeAdvisory({ fixedVersion: null }) }),
    );
    expect(flags.fixed_version_unknown).toBe(true);
  });

  it("sets registry_metadata_incomplete when latest_version is missing", () => {
    const flags = deriveConfidenceFlags(
      makeContext({ dependency: makeDependency({ latestVersion: null }) }),
    );
    expect(flags.registry_metadata_incomplete).toBe(true);
  });

  it("sets both downstream_dependents_unavailable and breaking_change_signals_unavailable when both prefetches are absent (ADR 0007 §5 / ADR 0029 / ADR 0032)", () => {
    const flags = deriveConfidenceFlags(
      makeContext({
        dependency: makeDependency({ resolvedVersion: "1.2.3", latestVersion: "1.4.0" }),
        advisory: makeAdvisory({ cvssScore: 9.0, fixedVersion: "1.2.4" }),
      }),
    );
    expect(flags.downstream_dependents_unavailable).toBe(true);
    expect(flags.breaking_change_signals_unavailable).toBe(true);
  });

  it("still sets breaking_change_signals_unavailable when effortSignals resolved but source_available is false (ADR 0029)", () => {
    const flags = deriveConfidenceFlags(
      makeContext({
        effortSignals: {
          has_migration_guide: false,
          breaking_change_signals: [],
          source_available: false,
        },
      }),
    );
    expect(flags.breaking_change_signals_unavailable).toBe(true);
  });

  it("does NOT set breaking_change_signals_unavailable when effortSignals resolved with source_available: true (ADR 0029)", () => {
    const flags = deriveConfidenceFlags(
      makeContext({
        effortSignals: {
          has_migration_guide: false,
          breaking_change_signals: [],
          source_available: true,
        },
      }),
    );
    expect(flags.breaking_change_signals_unavailable).toBeUndefined();
  });

  it("clearing breaking_change_signals_unavailable does not clear downstream_dependents_unavailable while the count is absent (ADR 0029 scope)", () => {
    const flags = deriveConfidenceFlags(
      makeContext({
        effortSignals: {
          has_migration_guide: false,
          breaking_change_signals: [],
          source_available: true,
        },
      }),
    );
    // Still set — downstreamDependents itself is absent (ADR 0032), so
    // resolving effortSignals alone doesn't close ADR 0006's gap.
    expect(flags.downstream_dependents_unavailable).toBe(true);
  });

  it("clears downstream_dependents_unavailable once a downstreamDependents count resolves, including a genuine 0 (ADR 0032)", () => {
    const resolved = deriveConfidenceFlags(makeContext({ downstreamDependents: 4320 }));
    const genuineZero = deriveConfidenceFlags(makeContext({ downstreamDependents: 0 }));
    expect(resolved.downstream_dependents_unavailable).toBeUndefined();
    expect(genuineZero.downstream_dependents_unavailable).toBeUndefined();
  });

  it("reaches zero flags — and thus high confidence — when both prefetches resolve for an otherwise-complete context (ADR 0029 + ADR 0032)", () => {
    const flags = deriveConfidenceFlags(
      makeContext({
        dependency: makeDependency({ resolvedVersion: "1.2.3", latestVersion: "1.4.0" }),
        advisory: makeAdvisory({ cvssScore: 9.0, fixedVersion: "1.2.4" }),
        effortSignals: {
          has_migration_guide: false,
          breaking_change_signals: [],
          source_available: true,
        },
        downstreamDependents: 250,
      }),
    );
    const flagCount = Object.values(flags).filter((v) => v === true).length;
    expect(flagCount).toBe(0);
    expect(deriveConfidence(flags)).toBe("high");
  });

  it("produces exactly the two structural flags for an otherwise-complete context when effortSignals is absent, never zero", () => {
    const flags = deriveConfidenceFlags(
      makeContext({
        dependency: makeDependency({ resolvedVersion: "1.2.3", latestVersion: "1.4.0" }),
        advisory: makeAdvisory({ cvssScore: 9.0, fixedVersion: "1.2.4" }),
      }),
    );
    const flagCount = Object.values(flags).filter((v) => v === true).length;
    expect(flagCount).toBe(2);
  });

  it("drops to exactly one structural flag once a source_available effortSignals resolves (ADR 0029)", () => {
    const flags = deriveConfidenceFlags(
      makeContext({
        dependency: makeDependency({ resolvedVersion: "1.2.3", latestVersion: "1.4.0" }),
        advisory: makeAdvisory({ cvssScore: 9.0, fixedVersion: "1.2.4" }),
        effortSignals: {
          has_migration_guide: false,
          breaking_change_signals: [],
          source_available: true,
        },
      }),
    );
    const flagCount = Object.values(flags).filter((v) => v === true).length;
    expect(flagCount).toBe(1);
    expect(deriveConfidence(flags)).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// deriveConfidence
// ---------------------------------------------------------------------------

describe("deriveConfidence", () => {
  it("returns high for zero flags", () => {
    expect(deriveConfidence({})).toBe("high");
  });

  it("returns medium for exactly one flag", () => {
    expect(deriveConfidence({ cvss_score_missing: true })).toBe("medium");
  });

  it("returns low for two or more flags", () => {
    expect(deriveConfidence({ cvss_score_missing: true, fixed_version_unknown: true })).toBe("low");
  });

  it("confirms a mission with both prefetches absent is low confidence, given the two structural flags (ADR 0007 §5, post-ADR-0032)", () => {
    const flags = deriveConfidenceFlags(
      makeContext({
        dependency: makeDependency({ resolvedVersion: "1.2.3", latestVersion: "1.4.0" }),
        advisory: makeAdvisory({ cvssScore: 9.0, fixedVersion: "1.2.4" }),
      }),
    );
    expect(deriveConfidence(flags)).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// buildConfidenceNotes
// ---------------------------------------------------------------------------

describe("buildConfidenceNotes", () => {
  it("produces one note per set flag, in flag order", () => {
    const notes = buildConfidenceNotes({ no_lock_file: true, cvss_score_missing: true });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/lock file/i);
    expect(notes[1]).toMatch(/CVSS/i);
  });

  it("produces no notes for an empty flag set", () => {
    expect(buildConfidenceNotes({})).toEqual([]);
  });

  it("ignores explicitly-false flags", () => {
    expect(buildConfidenceNotes({ no_lock_file: false })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeMissionScore — end to end
// ---------------------------------------------------------------------------

describe("computeMissionScore", () => {
  it("combines all three scorers into a single composite result", () => {
    const result = computeMissionScore(makeContext());

    expect(result.impact_score).toBeGreaterThan(0);
    expect(result.ecosystem_value_score).toBeGreaterThan(0);
    expect(result.composite_score).toBeCloseTo(
      result.impact_score * 0.6 + result.ecosystem_value_score * 0.4,
      9,
    );
    expect(result.scoring_version).toBe(SCORING_VERSION);
  });

  it("is low confidence given today's structural data gaps", () => {
    const result = computeMissionScore(makeContext());
    expect(result.confidence).toBe("low");
    expect(result.confidence_notes.length).toBeGreaterThan(0);
  });

  it("reaches high confidence and carries the real count when both prefetches resolve (ADR 0029 + ADR 0032)", () => {
    const ctx = makeContext({
      dependency: makeDependency({ resolvedVersion: "1.2.3", latestVersion: "1.4.0" }),
      advisory: makeAdvisory({ cvssScore: 9.0, fixedVersion: "1.2.4" }),
      effortSignals: {
        has_migration_guide: false,
        breaking_change_signals: [],
        source_available: true,
      },
      downstreamDependents: 250,
    });
    const result = computeMissionScore(ctx);
    expect(result.confidence).toBe("high");
    expect(result.confidence_notes).toEqual([]);
    expect(result.ecosystem_value_inputs.downstream_dependents).toBe(250);
  });

  it("carries the exact inputs used through to the result, for auditability", () => {
    const ctx = makeContext({ advisory: makeAdvisory({ cvssScore: 6.5, severity: "medium" }) });
    const result = computeMissionScore(ctx);
    expect(result.impact_inputs.cvss_score).toBe(6.5);
    expect(result.impact_inputs.severity).toBe("medium");
  });
});
