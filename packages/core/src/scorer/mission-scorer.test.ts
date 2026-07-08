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
  SCORING_VERSION,
  type MissionScoringContext,
} from "./mission-scorer.js";
import type { Advisory, Dependency, Repo } from "../db/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDependency(overrides: Partial<Dependency> = {}): Dependency {
  return {
    id: "dep-1",
    repo_id: "repo-1",
    ecosystem: "npm",
    package_name: "left-pad",
    version_spec: "^1.2.3",
    resolved_version: null,
    dep_type: "production",
    latest_version: "1.4.0",
    is_deprecated: false,
    deprecation_note: null,
    created_at: new Date("2026-06-01T00:00:00Z"),
    updated_at: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

function makeAdvisory(overrides: Partial<Advisory> = {}): Advisory {
  return {
    id: "adv-1",
    osv_id: "GHSA-xxxx-xxxx-xxxx",
    source: "osv",
    ecosystem: "npm",
    package_name: "left-pad",
    severity: "high",
    cvss_score: 7.5,
    summary: "Example advisory",
    details: null,
    affected_versions: [],
    fixed_version: "1.2.4",
    published_at: new Date("2026-06-01T00:00:00Z"),
    modified_at: null,
    raw_data: {},
    created_at: new Date("2026-06-01T00:00:00Z"),
    updated_at: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo-1",
    github_url: "https://github.com/example/example",
    owner: "example",
    name: "example",
    default_branch: "main",
    description: null,
    stars: 1000,
    open_issues_count: 100,
    topics: [],
    homepage_url: null,
    ingestion_status: "complete",
    last_ingested_at: new Date("2026-07-01T00:00:00Z"),
    ingestion_error: null,
    submitted_by: null,
    created_at: new Date("2026-06-01T00:00:00Z"),
    updated_at: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

function makeContext(overrides: Partial<MissionScoringContext> = {}): MissionScoringContext {
  return {
    dependency: makeDependency(),
    advisory: makeAdvisory(),
    repo: makeRepo(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildImpactInputs
// ---------------------------------------------------------------------------

describe("buildImpactInputs", () => {
  it("maps cvss_score, severity, and dep_type directly from the advisory/dependency", () => {
    const inputs = buildImpactInputs(
      makeContext({
        advisory: makeAdvisory({ cvss_score: 8.1, severity: "critical" }),
        dependency: makeDependency({ dep_type: "peer" }),
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
    const inputs = buildImpactInputs(
      makeContext({ advisory: makeAdvisory({ published_at: publishedAt }) }),
    );
    expect(inputs.days_since_advisory).toBe(10);
  });

  it("returns null days_since_advisory when published_at is null", () => {
    const inputs = buildImpactInputs(
      makeContext({ advisory: makeAdvisory({ published_at: null }) }),
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
        dependency: makeDependency({ version_spec: "^1.2.3" }),
        advisory: makeAdvisory({ fixed_version: "1.2.4" }),
      }),
    );
    expect(inputs.semver_bump).toBe("patch");
  });

  it("infers a minor bump", () => {
    const inputs = buildEffortInputs(
      makeContext({
        dependency: makeDependency({ version_spec: "^1.2.3" }),
        advisory: makeAdvisory({ fixed_version: "1.3.0" }),
      }),
    );
    expect(inputs.semver_bump).toBe("minor");
  });

  it("infers a major bump", () => {
    const inputs = buildEffortInputs(
      makeContext({
        dependency: makeDependency({ version_spec: "^1.2.3" }),
        advisory: makeAdvisory({ fixed_version: "2.0.0" }),
      }),
    );
    expect(inputs.semver_bump).toBe("major");
  });

  it("falls back to dependency.latest_version when the advisory has no fixed_version", () => {
    const inputs = buildEffortInputs(
      makeContext({
        dependency: makeDependency({ version_spec: "^1.2.3", latest_version: "1.3.0" }),
        advisory: makeAdvisory({ fixed_version: null }),
      }),
    );
    expect(inputs.semver_bump).toBe("minor");
  });

  it("returns unknown when neither fixed_version nor latest_version is available", () => {
    const inputs = buildEffortInputs(
      makeContext({
        dependency: makeDependency({ latest_version: null }),
        advisory: makeAdvisory({ fixed_version: null }),
      }),
    );
    expect(inputs.semver_bump).toBe("unknown");
  });

  it("returns unknown for a wildcard range rather than fabricating a major bump", () => {
    const inputs = buildEffortInputs(
      makeContext({ dependency: makeDependency({ version_spec: "*" }) }),
    );
    expect(inputs.semver_bump).toBe("unknown");
  });

  it("returns unknown for an empty range string", () => {
    const inputs = buildEffortInputs(
      makeContext({ dependency: makeDependency({ version_spec: "" }) }),
    );
    expect(inputs.semver_bump).toBe("unknown");
  });

  it.each(["latest", "next", "workspace:*", "file:../foo", "git+https://github.com/a/b.git"])(
    "returns unknown rather than throwing for the non-range spec %s",
    (versionSpec) => {
      expect(() =>
        buildEffortInputs(
          makeContext({ dependency: makeDependency({ version_spec: versionSpec }) }),
        ),
      ).not.toThrow();
      const inputs = buildEffortInputs(
        makeContext({ dependency: makeDependency({ version_spec: versionSpec }) }),
      );
      expect(inputs.semver_bump).toBe("unknown");
    },
  );

  it("returns unknown when the target version is not coercible to semver", () => {
    const inputs = buildEffortInputs(
      makeContext({
        dependency: makeDependency({ version_spec: "^1.2.3" }),
        advisory: makeAdvisory({ fixed_version: "not-a-version" }),
      }),
    );
    expect(inputs.semver_bump).toBe("unknown");
  });

  it("stubs has_migration_guide as false and breaking_change_signals as empty (ADR 0007 §5)", () => {
    const inputs = buildEffortInputs(makeContext());
    expect(inputs.has_migration_guide).toBe(false);
    expect(inputs.breaking_change_signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildEcosystemValueInputs
// ---------------------------------------------------------------------------

describe("buildEcosystemValueInputs", () => {
  it("maps repo_stars and open_issues_count directly, and downstream_dependents as null", () => {
    const inputs = buildEcosystemValueInputs(
      makeContext({ repo: makeRepo({ stars: 4200, open_issues_count: 17 }) }),
    );
    expect(inputs.repo_stars).toBe(4200);
    expect(inputs.open_issues_count).toBe(17);
    expect(inputs.downstream_dependents).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveConfidenceFlags
// ---------------------------------------------------------------------------

describe("deriveConfidenceFlags", () => {
  it("sets no_lock_file from dependency.resolved_version, not lock_file_present (ADR 0007 §3)", () => {
    const withResolved = deriveConfidenceFlags(
      makeContext({ dependency: makeDependency({ resolved_version: "1.2.3" }) }),
    );
    const withoutResolved = deriveConfidenceFlags(
      makeContext({ dependency: makeDependency({ resolved_version: null }) }),
    );
    expect(withResolved.no_lock_file).toBeUndefined();
    expect(withoutResolved.no_lock_file).toBe(true);
  });

  it("sets cvss_score_missing when the advisory has no CVSS score", () => {
    const flags = deriveConfidenceFlags(
      makeContext({ advisory: makeAdvisory({ cvss_score: null }) }),
    );
    expect(flags.cvss_score_missing).toBe(true);
  });

  it("sets fixed_version_unknown when the advisory has no fixed version", () => {
    const flags = deriveConfidenceFlags(
      makeContext({ advisory: makeAdvisory({ fixed_version: null }) }),
    );
    expect(flags.fixed_version_unknown).toBe(true);
  });

  it("sets registry_metadata_incomplete when latest_version is missing", () => {
    const flags = deriveConfidenceFlags(
      makeContext({ dependency: makeDependency({ latest_version: null }) }),
    );
    expect(flags.registry_metadata_incomplete).toBe(true);
  });

  it("always sets downstream_dependents_unavailable and breaking_change_signals_unavailable (ADR 0007 §5)", () => {
    const flags = deriveConfidenceFlags(
      makeContext({
        dependency: makeDependency({ resolved_version: "1.2.3", latest_version: "1.4.0" }),
        advisory: makeAdvisory({ cvss_score: 9.0, fixed_version: "1.2.4" }),
      }),
    );
    expect(flags.downstream_dependents_unavailable).toBe(true);
    expect(flags.breaking_change_signals_unavailable).toBe(true);
  });

  it("produces exactly the two structural flags for an otherwise-complete context, never zero", () => {
    const flags = deriveConfidenceFlags(
      makeContext({
        dependency: makeDependency({ resolved_version: "1.2.3", latest_version: "1.4.0" }),
        advisory: makeAdvisory({ cvss_score: 9.0, fixed_version: "1.2.4" }),
      }),
    );
    const flagCount = Object.values(flags).filter((v) => v === true).length;
    expect(flagCount).toBe(2);
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

  it("confirms every Phase 2 mission is low confidence, given the two always-on flags (ADR 0007 §5)", () => {
    const flags = deriveConfidenceFlags(
      makeContext({
        dependency: makeDependency({ resolved_version: "1.2.3", latest_version: "1.4.0" }),
        advisory: makeAdvisory({ cvss_score: 9.0, fixed_version: "1.2.4" }),
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

  it("carries the exact inputs used through to the result, for auditability", () => {
    const ctx = makeContext({ advisory: makeAdvisory({ cvss_score: 6.5, severity: "medium" }) });
    const result = computeMissionScore(ctx);
    expect(result.impact_inputs.cvss_score).toBe(6.5);
    expect(result.impact_inputs.severity).toBe("medium");
  });
});
