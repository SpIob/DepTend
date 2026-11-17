/**
 * Markdown output formatter unit tests
 *
 * Snapshot-style assertions for the Markdown output format.
 */

import { describe, expect, it } from "vitest";
import { formatMarkdown } from "./markdown.js";
import type { AnalyzeResult, AnalyzedMission } from "../types.js";

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

describe("formatMarkdown", () => {
  it("includes repo header with owner/name", () => {
    const result = makeResult([baseMission]);
    const md = formatMarkdown(result);
    expect(md).toContain("# DepTend Analysis: owner/repo");
  });

  it("includes generation timestamp", () => {
    const result = makeResult([baseMission]);
    const md = formatMarkdown(result);
    expect(md).toContain("**Generated:**");
    expect(md).toContain("2026");
  });

  it("includes ecosystem and dependency count", () => {
    const result = makeResult([baseMission]);
    const md = formatMarkdown(result);
    expect(md).toContain("**Ecosystem:** npm");
    expect(md).toContain("**Dependencies scanned:** 1");
  });

  it("includes lock file status", () => {
    const result = makeResult([baseMission]);
    const md = formatMarkdown(result);
    expect(md).toContain("**Lock file present:** Yes");
  });

  it("includes mission count", () => {
    const result = makeResult([baseMission]);
    const md = formatMarkdown(result);
    expect(md).toContain("**Missions found:** 1");
  });

  it("shows 'No open vulnerability missions' when empty", () => {
    const result = makeResult([]);
    const md = formatMarkdown(result);
    expect(md).toContain("No open vulnerability missions found.");
  });

  it("includes summary table with headers", () => {
    const result = makeResult([baseMission]);
    const md = formatMarkdown(result);
    expect(md).toContain("## Mission Summary");
    expect(md).toContain("| Severity | Score | Effort | Package | Advisory |");
    expect(md).toContain("| --- | --- | --- | --- | --- |");
  });

  it("includes mission row in summary table with severity emoji", () => {
    const result = makeResult([baseMission]);
    const md = formatMarkdown(result);
    expect(md).toContain("🟠 HIGH");
    expect(md).toContain("5.0");
    expect(md).toContain("LOW");
    expect(md).toContain("test-package@^1.0.0");
    expect(md).toContain("[GHSA-test-1]");
  });

  it("includes detailed mission section", () => {
    const result = makeResult([baseMission]);
    const md = formatMarkdown(result);
    expect(md).toContain("## Mission Details");
    expect(md).toContain("### 🟠 HIGH — Test vulnerability");
    expect(md).toContain("**Package:** `test-package`");
    expect(md).toContain("**Advisory:** [GHSA-test-1]");
    expect(md).toContain("**Severity:** HIGH (CVSS: 7.5)");
    expect(md).toContain("**Fixed version:** 1.0.1");
    expect(md).toContain("**Composite score:** 5.0");
    expect(md).toContain("**Effort:** LOW");
    expect(md).toContain("**Confidence:** LOW");
    expect(md).toContain("**Action:** Upgrade to fixed version");
  });

  it("handles multiple missions", () => {
    const missions = [
      { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-1" } },
      {
        ...baseMission,
        advisory: { ...baseMission.advisory, osv_id: "GHSA-2", severity: "medium" as const },
      },
    ];
    const result = makeResult(missions);
    const md = formatMarkdown(result);

    expect(md).toContain("[GHSA-1]");
    expect(md).toContain("[GHSA-2]");
    expect(md).toContain("🟡 MEDIUM");
  });

  it("includes warnings section when present", () => {
    const result = makeResult([baseMission]);
    result.warnings = ["Warning A", "Warning B"];
    const md = formatMarkdown(result);
    expect(md).toContain("## Warnings");
    expect(md).toContain("- Warning A");
    expect(md).toContain("- Warning B");
  });

  it("handles missing CVSS score gracefully", () => {
    const mission = { ...baseMission, advisory: { ...baseMission.advisory, cvss_score: null } };
    const result = makeResult([mission]);
    const md = formatMarkdown(result);
    expect(md).toContain("CVSS: N/A");
  });

  it("handles missing fixed version gracefully", () => {
    const mission = { ...baseMission, advisory: { ...baseMission.advisory, fixed_version: null } };
    const result = makeResult([mission]);
    const md = formatMarkdown(result);
    expect(md).toContain("**Fixed version:** unknown");
  });

  it("handles missing action hint gracefully", () => {
    const mission = { ...baseMission, action_hint: null };
    const result = makeResult([mission]);
    const md = formatMarkdown(result);
    // Should not contain Action line when null
    const actionLines = md.split("\n").filter((line) => line.includes("**Action:**"));
    expect(actionLines).toHaveLength(0);
  });

  it("uses correct severity emojis", () => {
    const criticalMission = {
      ...baseMission,
      advisory: { ...baseMission.advisory, severity: "critical" as const },
    };
    const highMission = {
      ...baseMission,
      advisory: { ...baseMission.advisory, severity: "high" as const },
    };
    const mediumMission = {
      ...baseMission,
      advisory: { ...baseMission.advisory, severity: "medium" as const },
    };
    const lowMission = {
      ...baseMission,
      advisory: { ...baseMission.advisory, severity: "low" as const },
    };

    expect(formatMarkdown(makeResult([criticalMission]))).toContain("🔴");
    expect(formatMarkdown(makeResult([highMission]))).toContain("🟠");
    expect(formatMarkdown(makeResult([mediumMission]))).toContain("🟡");
    expect(formatMarkdown(makeResult([lowMission]))).toContain("🟢");
  });

  it("produces consistent output for same input", () => {
    const result = makeResult([baseMission]);
    const md1 = formatMarkdown(result);
    const md2 = formatMarkdown(result);
    expect(md1).toBe(md2);
  });
});
