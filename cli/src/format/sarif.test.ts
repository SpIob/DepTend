/**
 * SARIF output formatter unit tests
 *
 * Validates required SARIF 2.1.0 fields ($schema, version, runs[].tool.driver, results[].ruleId).
 * Not just "didn't throw" — actual field assertions.
 */

import { describe, expect, it } from "vitest";
import { formatSarif } from "./sarif.js";
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

describe("formatSarif", () => {
  it("produces valid SARIF 2.1.0 with required top-level fields", () => {
    const result = makeResult([baseMission]);
    const sarif = JSON.parse(formatSarif(result));

    expect(sarif.$schema).toBe(
      "https://schemastore.azurewebsites.net/schemas/json/sarif-2.1.0.json",
    );
    expect(sarif.version).toBe("2.1.0");
    expect(Array.isArray(sarif.runs)).toBe(true);
    expect(sarif.runs).toHaveLength(1);
  });

  it("includes tool driver with name, version, and rules", () => {
    const result = makeResult([baseMission]);
    const sarif = JSON.parse(formatSarif(result));

    const driver = sarif.runs[0].tool.driver;
    expect(driver.name).toBe("deptend");
    expect(driver.version).toBeDefined();
    expect(driver.informationUri).toBe("https://deptend.vercel.app");
    expect(Array.isArray(driver.rules)).toBe(true);
    expect(driver.rules).toHaveLength(1);
  });

  it("creates one rule per unique advisory OSV ID", () => {
    const missions = [
      { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-1" } },
      { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-2" } },
      { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-1" } }, // duplicate
    ];
    const result = makeResult(missions);
    const sarif = JSON.parse(formatSarif(result));

    expect(sarif.runs[0].tool.driver.rules).toHaveLength(2);
    const ruleIds = sarif.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
    expect(ruleIds).toContain("GHSA-1");
    expect(ruleIds).toContain("GHSA-2");
  });

  it("creates one result per mission", () => {
    const missions = [
      { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-1" } },
      { ...baseMission, advisory: { ...baseMission.advisory, osv_id: "GHSA-2" } },
    ];
    const result = makeResult(missions);
    const sarif = JSON.parse(formatSarif(result));

    expect(sarif.runs[0].results).toHaveLength(2);
  });

  it("each result has required ruleId field", () => {
    const result = makeResult([baseMission]);
    const sarif = JSON.parse(formatSarif(result));

    const sarifResult = sarif.runs[0].results[0];
    expect(sarifResult.ruleId).toBe("GHSA-test-1");
  });

  it("maps severity to SARIF level correctly", () => {
    const criticalMission = {
      ...baseMission,
      advisory: { ...baseMission.advisory, severity: "critical" as const, osv_id: "GHSA-critical" },
    };
    const highMission = {
      ...baseMission,
      advisory: { ...baseMission.advisory, severity: "high" as const, osv_id: "GHSA-high" },
    };
    const mediumMission = {
      ...baseMission,
      advisory: { ...baseMission.advisory, severity: "medium" as const, osv_id: "GHSA-medium" },
    };
    const lowMission = {
      ...baseMission,
      advisory: { ...baseMission.advisory, severity: "low" as const, osv_id: "GHSA-low" },
    };

    const criticalResult = makeResult([criticalMission]);
    const highResult = makeResult([highMission]);
    const mediumResult = makeResult([mediumMission]);
    const lowResult = makeResult([lowMission]);

    expect(JSON.parse(formatSarif(criticalResult)).runs[0].results[0].level).toBe("error");
    expect(JSON.parse(formatSarif(highResult)).runs[0].results[0].level).toBe("error");
    expect(JSON.parse(formatSarif(mediumResult)).runs[0].results[0].level).toBe("warning");
    expect(JSON.parse(formatSarif(lowResult)).runs[0].results[0].level).toBe("note");
  });

  it("includes composite_score, effort_label, confidence in result.properties", () => {
    const result = makeResult([baseMission]);
    const sarif = JSON.parse(formatSarif(result));

    const props = sarif.runs[0].results[0].properties;
    expect(props.compositeScore).toBe(5.0);
    expect(props.effortLabel).toBe("low");
    expect(props.confidence).toBe("low");
  });

  it("includes scoring inputs in result.properties.scoringInputs", () => {
    const result = makeResult([baseMission]);
    const sarif = JSON.parse(formatSarif(result));

    const props = sarif.runs[0].results[0].properties;
    expect(props.scoringInputs).toBeDefined();
    expect(props.scoringInputs.impact).toBeDefined();
    expect(props.scoringInputs.effort).toBeDefined();
    expect(props.scoringInputs.ecosystemValue).toBeDefined();
  });

  it("includes package details in result.properties", () => {
    const result = makeResult([baseMission]);
    const sarif = JSON.parse(formatSarif(result));

    const props = sarif.runs[0].results[0].properties;
    expect(props.packageName).toBe("test-package");
    expect(props.versionSpec).toBe("^1.0.0");
    expect(props.latestVersion).toBe("1.0.0");
    expect(props.depType).toBe("production");
    expect(props.isDeprecated).toBe(false);
  });

  it("includes rule metadata (severity, cvss, fixedVersion)", () => {
    const result = makeResult([baseMission]);
    const sarif = JSON.parse(formatSarif(result));

    const rule = sarif.runs[0].tool.driver.rules[0];
    expect(rule.id).toBe("GHSA-test-1");
    expect(rule.properties.severity).toBe("high");
    expect(rule.properties.cvssScore).toBe(7.5);
    expect(rule.properties.fixedVersion).toBe("1.0.1");
  });

  it("handles empty missions array", () => {
    const result = makeResult([]);
    const sarif = JSON.parse(formatSarif(result));

    expect(sarif.runs[0].tool.driver.rules).toHaveLength(0);
    expect(sarif.runs[0].results).toHaveLength(0);
  });

  it("includes columnKind in run", () => {
    const result = makeResult([baseMission]);
    const sarif = JSON.parse(formatSarif(result));

    expect(sarif.runs[0].columnKind).toBe("utf16");
  });

  it("produces valid JSON that can be parsed", () => {
    const result = makeResult([baseMission]);
    const output = formatSarif(result);

    // Should not throw
    expect(() => JSON.parse(output)).not.toThrow();
  });
});
