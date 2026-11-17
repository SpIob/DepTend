/**
 * Baseline diff utility unit tests
 *
 * Tests for parsing baseline files, computing diffs, and formatting summaries.
 */

import { describe, expect, it } from "vitest";
import {
  parseBaselineFile,
  computeBaselineDiff,
  formatDiffSummary,
  type BaselineFile,
} from "./baseline.js";
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

function makeBaseline(missions: BaselineFile["missions"]): BaselineFile {
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

function baselineMission(
  overrides: Partial<BaselineFile["missions"][0]> = {},
): BaselineFile["missions"][0] {
  return {
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
    ...overrides,
  };
}

describe("parseBaselineFile", () => {
  it("parses a valid baseline file", () => {
    const baseline = makeBaseline([baselineMission()]);
    const parsed = parseBaselineFile(JSON.stringify(baseline));
    expect(parsed).not.toBeNull();
    expect(parsed?.missions).toHaveLength(1);
    expect(parsed?.ecosystem).toBe("npm");
  });

  it("returns null for invalid JSON", () => {
    expect(parseBaselineFile("not valid json")).toBeNull();
  });

  it("returns null for missing required fields", () => {
    const incomplete = { generated_at: "2026-01-01T00:00:00.000Z" };
    expect(parseBaselineFile(JSON.stringify(incomplete))).toBeNull();
  });

  it("returns null for missions without required fields", () => {
    const baseline = makeBaseline([
      { ...baselineMission(), advisory: { ...baselineMission().advisory, osv_id: "" } },
    ]);
    expect(parseBaselineFile(JSON.stringify(baseline))).toBeNull();
  });

  it("returns null for missions without dependency.package_name", () => {
    const baseline = makeBaseline([
      { ...baselineMission(), dependency: { ...baselineMission().dependency, package_name: "" } },
    ]);
    expect(parseBaselineFile(JSON.stringify(baseline))).toBeNull();
  });
});

describe("computeBaselineDiff", () => {
  it("returns empty diff when current matches baseline", () => {
    const mission = { ...baseMission };
    const current = makeResult([mission]);
    const baseline = makeBaseline([baselineMission()]);

    const diff = computeBaselineDiff(current, baseline);

    expect(diff.added).toHaveLength(0);
    expect(diff.resolved).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(1);
  });

  it("detects added missions", () => {
    const current = makeResult([
      { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-new" } },
    ]);
    const baseline = makeBaseline([]);

    const diff = computeBaselineDiff(current, baseline);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.advisory.osv_id).toBe("GHSA-new");
    expect(diff.resolved).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
  });

  it("detects resolved missions", () => {
    const current = makeResult([]);
    const baseline = makeBaseline([
      baselineMission({ advisory: { ...baselineMission().advisory, osv_id: "GHSA-old" } }),
    ]);

    const diff = computeBaselineDiff(current, baseline);

    expect(diff.added).toHaveLength(0);
    expect(diff.resolved).toHaveLength(1);
    expect(diff.resolved[0]?.advisory.osv_id).toBe("GHSA-old");
    expect(diff.unchanged).toHaveLength(0);
  });

  it("detects mixed added, resolved, and unchanged", () => {
    const current = makeResult([
      { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-unchanged" } },
      { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-new" } },
    ]);
    const baseline = makeBaseline([
      baselineMission({ advisory: { ...baselineMission().advisory, osv_id: "GHSA-unchanged" } }),
      baselineMission({ advisory: { ...baselineMission().advisory, osv_id: "GHSA-resolved" } }),
    ]);

    const diff = computeBaselineDiff(current, baseline);

    expect(diff.unchanged).toHaveLength(1);
    expect(diff.unchanged[0]?.advisory.osv_id).toBe("GHSA-unchanged");
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.advisory.osv_id).toBe("GHSA-new");
    expect(diff.resolved).toHaveLength(1);
    expect(diff.resolved[0]?.advisory.osv_id).toBe("GHSA-resolved");
  });

  it("matches by osv_id + package_name + ecosystem", () => {
    const current = makeResult([
      {
        ...baseMission,
        advisory: { ...baseMission.advisory, osv_id: "GHSA-1" },
        dependency: { ...baseMission.dependency, package_name: "pkg-a" },
      },
    ]);
    const baseline = makeBaseline([
      baselineMission({
        advisory: { ...baselineMission().advisory, osv_id: "GHSA-1" },
        dependency: { ...baselineMission().dependency, package_name: "pkg-b" },
      }),
    ]);

    const diff = computeBaselineDiff(current, baseline);

    // Different package names should be treated as different missions
    expect(diff.added).toHaveLength(1);
    expect(diff.resolved).toHaveLength(1);
    expect(diff.unchanged).toHaveLength(0);
  });

  it("handles different ecosystems as different missions", () => {
    const current = makeResult([
      {
        ...baseMission,
        advisory: { ...baseMission.advisory, osv_id: "GHSA-1" },
        dependency: { ...baseMission.dependency, package_name: "pkg" },
      },
    ]);
    current.ecosystem = "npm";

    const baseline = makeBaseline([
      baselineMission({
        advisory: { ...baselineMission().advisory, osv_id: "GHSA-1" },
        dependency: { ...baselineMission().dependency, package_name: "pkg" },
      }),
    ]);
    baseline.ecosystem = "pypi";

    const diff = computeBaselineDiff(current, baseline);

    // Different ecosystems should be treated as different missions
    expect(diff.added).toHaveLength(1);
    expect(diff.resolved).toHaveLength(1);
    expect(diff.unchanged).toHaveLength(0);
  });
});

describe("formatDiffSummary", () => {
  it("returns 'No changes since baseline.' when diff is empty", () => {
    const diff = { added: [], resolved: [], unchanged: [] };
    expect(formatDiffSummary(diff)).toBe("No changes since baseline.");
  });

  it("returns 'No changes since baseline.' when only unchanged missions exist", () => {
    const diff = {
      added: [],
      resolved: [],
      unchanged: [baseMission, baseMission],
    };
    expect(formatDiffSummary(diff)).toBe("No changes since baseline.");
  });

  it("formats added missions", () => {
    const diff = {
      added: [
        { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-new-12345678" } },
      ],
      resolved: [],
      unchanged: [],
    };
    const summary = formatDiffSummary(diff);
    expect(summary).toContain("## Diff vs Baseline");
    expect(summary).toContain("### ➕ Added (1)");
    expect(summary).toContain("GHSA-new");
  });

  it("formats resolved missions", () => {
    const diff = {
      added: [],
      resolved: [
        { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-resolved-12345678" } },
      ],
      unchanged: [],
    };
    const summary = formatDiffSummary(diff);
    expect(summary).toContain("### ✅ Resolved (1)");
    expect(summary).toContain("GHSA-res");
  });

  it("truncates long OSV IDs in summary", () => {
    const diff = {
      added: [
        {
          ...baseMission,
          advisory: {
            ...baseMission.advisory,
            osv_id: "GHSA-very-long-id-that-exceeds-eight-chars",
          },
        },
      ],
      resolved: [],
      unchanged: [],
    };
    const summary = formatDiffSummary(diff);
    expect(summary).toContain("GHSA-ver");
  });
});
