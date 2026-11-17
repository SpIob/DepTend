/**
 * checkFailOnThresholds unit tests
 *
 * Pure logic tests for the --fail-on threshold checking function.
 * No network, no filesystem — just data in, assertion out.
 */

import { describe, expect, it } from "vitest";
import { checkFailOnThresholds } from "./index.js";
import type { AnalyzeResult, AnalyzedMission } from "./types.js";

const baseMission: AnalyzedMission = {
  title: "Update package to fix vulnerability",
  description: "Package is vulnerable",
  action_hint: "Upgrade to fixed version",
  composite_score: 5.0,
  impact_score: 7.5,
  ecosystem_value_score: 1.28,
  effort_label: "low",
  confidence: "low",
  confidence_notes: [],
  scoring_version: "1.1.0",
  scoring_inputs: {
    impact: {
      cvss_score: 7.5,
      severity: "high",
      is_transitive: false,
      dep_type: "production",
      days_since_advisory: 100,
      epss_score: null,
    },
    effort: {
      semver_bump: "minor",
      has_migration_guide: false,
      breaking_change_signals: [],
    },
    ecosystem_value: { repo_stars: 1, open_issues_count: 0, downstream_dependents: null },
  },
  dependency: {
    package_name: "test-package",
    version_spec: "^1.0.0",
    dep_type: "production",
    latest_version: "1.0.0",
    is_deprecated: false,
  },
  advisory: {
    osv_id: "GHSA-test-1",
    source: "ghsa",
    severity: "high",
    cvss_score: 7.5,
    fixed_version: "1.0.1",
    summary: "Test vulnerability",
    url: "https://github.com/advisories/GHSA-test-1",
  },
};

function makeResult(missions: AnalyzedMission[]): AnalyzeResult {
  return {
    generated_at: "2026-01-01T00:00:00.000Z",
    repo: {
      github_url: "https://github.com/owner/repo",
      owner: "owner",
      name: "repo",
      default_branch: "main",
      stars: 100,
      open_issues_count: 5,
    },
    dependencies_scanned: missions.length,
    ecosystem: "npm",
    lock_file_present: true,
    missions,
    warnings: [],
  };
}

describe("checkFailOnThresholds", () => {
  it("returns null when no fail-on flags are set", () => {
    const result = makeResult([
      { ...baseMission, advisory: { ...baseMission.advisory, severity: "high" } },
    ]);
    expect(checkFailOnThresholds(result, null, null)).toBeNull();
  });

  it("returns null when --fail-on=critical and no critical missions", () => {
    const result = makeResult([
      { ...baseMission, advisory: { ...baseMission.advisory, severity: "high" } },
    ]);
    expect(checkFailOnThresholds(result, "critical", null)).toBeNull();
  });

  it("trips when --fail-on=critical and a critical mission exists", () => {
    const criticalMission: AnalyzedMission = {
      ...baseMission,
      advisory: { ...baseMission.advisory, osv_id: "GHSA-critical", severity: "critical" },
      composite_score: 9.0,
    };
    const result = makeResult([criticalMission]);
    const summary = checkFailOnThresholds(result, "critical", null);
    expect(summary).not.toBeNull();
    expect(summary).toContain("GHSA-critical");
    expect(summary).toContain("critical");
    expect(summary).toContain("9.0");
  });

  it("trips when --fail-on=high and a high mission exists", () => {
    const result = makeResult([
      { ...baseMission, advisory: { ...baseMission.advisory, severity: "high" } },
    ]);
    const summary = checkFailOnThresholds(result, "high", null);
    expect(summary).not.toBeNull();
    expect(summary).toContain("GHSA-test-1");
    expect(summary).toContain("high");
  });

  it("trips when --fail-on=high and a critical mission exists (higher severity)", () => {
    const criticalMission: AnalyzedMission = {
      ...baseMission,
      advisory: { ...baseMission.advisory, osv_id: "GHSA-critical", severity: "critical" },
      composite_score: 9.0,
    };
    const result = makeResult([criticalMission]);
    const summary = checkFailOnThresholds(result, "high", null);
    expect(summary).not.toBeNull();
    expect(summary).toContain("GHSA-critical");
  });

  it("does not trip when --fail-on=high and only medium missions exist", () => {
    const result = makeResult([
      { ...baseMission, advisory: { ...baseMission.advisory, severity: "medium" } },
    ]);
    expect(checkFailOnThresholds(result, "high", null)).toBeNull();
  });

  it("trips when --fail-on=medium and a medium mission exists", () => {
    const result = makeResult([
      { ...baseMission, advisory: { ...baseMission.advisory, severity: "medium" } },
    ]);
    const summary = checkFailOnThresholds(result, "medium", null);
    expect(summary).not.toBeNull();
    expect(summary).toContain("medium");
  });

  it("trips when --fail-on=low and a low mission exists", () => {
    const result = makeResult([
      { ...baseMission, advisory: { ...baseMission.advisory, severity: "low" } },
    ]);
    const summary = checkFailOnThresholds(result, "low", null);
    expect(summary).not.toBeNull();
    expect(summary).toContain("low");
  });

  it("trips when --fail-on=any and any mission exists", () => {
    const result = makeResult([
      { ...baseMission, advisory: { ...baseMission.advisory, severity: "low" } },
    ]);
    const summary = checkFailOnThresholds(result, "any", null);
    expect(summary).not.toBeNull();
    expect(summary).toContain("GHSA-test-1");
  });

  it("returns null when --fail-on=any and no missions exist", () => {
    const result = makeResult([]);
    expect(checkFailOnThresholds(result, "any", null)).toBeNull();
  });

  it("trips when --fail-on-count threshold is met", () => {
    const missions: AnalyzedMission[] = [
      { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-1" } },
      { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-2" } },
      { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-3" } },
    ];
    const result = makeResult(missions);
    const summary = checkFailOnThresholds(result, null, 3);
    expect(summary).not.toBeNull();
    expect(summary).toContain("GHSA-1");
    expect(summary).toContain("GHSA-2");
    expect(summary).toContain("GHSA-3");
  });

  it("does not trip when --fail-on-count threshold is not met", () => {
    const missions: AnalyzedMission[] = [
      { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-1" } },
      { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-2" } },
    ];
    const result = makeResult(missions);
    expect(checkFailOnThresholds(result, null, 3)).toBeNull();
  });

  it("trips when either --fail-on OR --fail-on-count is met (OR semantics)", () => {
    // Only count threshold met
    const missions: AnalyzedMission[] = [
      { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-1", severity: "low" } },
      { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-2", severity: "low" } },
    ];
    const result = makeResult(missions);
    const summary = checkFailOnThresholds(result, "high", 2);
    expect(summary).not.toBeNull();
    expect(summary).toContain("GHSA-1");
    expect(summary).toContain("GHSA-2");
  });

  it("lists only severity-matching missions when both flags set and severity trips", () => {
    const missions: AnalyzedMission[] = [
      {
        ...baseMission,
        advisory: { ...baseMission.advisory, osv_id: "GHSA-high", severity: "high" },
      },
      {
        ...baseMission,
        advisory: { ...baseMission.advisory, osv_id: "GHSA-low", severity: "low" },
      },
    ];
    const result = makeResult(missions);
    // fail-on=high should only list the high severity mission
    const summary = checkFailOnThresholds(result, "high", 10);
    expect(summary).not.toBeNull();
    expect(summary).toContain("GHSA-high");
    expect(summary).not.toContain("GHSA-low");
  });

  it("lists all missions when count trips but severity does not", () => {
    const missions: AnalyzedMission[] = [
      {
        ...baseMission,
        advisory: { ...baseMission.advisory, osv_id: "GHSA-low-1", severity: "low" },
      },
      {
        ...baseMission,
        advisory: { ...baseMission.advisory, osv_id: "GHSA-low-2", severity: "low" },
      },
    ];
    const result = makeResult(missions);
    // fail-on=high (no match), fail-on-count=2 (matches)
    const summary = checkFailOnThresholds(result, "high", 2);
    expect(summary).not.toBeNull();
    expect(summary).toContain("GHSA-low-1");
    expect(summary).toContain("GHSA-low-2");
  });

  it("handles case-insensitive severity comparison", () => {
    const result = makeResult([
      { ...baseMission, advisory: { ...baseMission.advisory, severity: "high" } },
    ]);
    const summary = checkFailOnThresholds(result, "high", null);
    expect(summary).not.toBeNull();
    expect(summary).toContain("high");
  });

  it("includes composite_score in the summary", () => {
    const mission = { ...baseMission, composite_score: 7.5 };
    const result = makeResult([mission]);
    const summary = checkFailOnThresholds(result, "high", null);
    expect(summary).not.toBeNull();
    expect(summary).toContain("7.5");
  });

  it("handles unknown severity gracefully (treats as rank 0)", () => {
    const result = makeResult([
      { ...baseMission, advisory: { ...baseMission.advisory, severity: "unknown" } },
    ]);
    expect(checkFailOnThresholds(result, "high", null)).toBeNull();
    // --fail-on=any should still trip
    const summary = checkFailOnThresholds(result, "any", null);
    expect(summary).not.toBeNull();
  });
});
