/**
 * SARIF 2.1.0 output formatter
 *
 * Produces SARIF output compatible with GitHub code scanning.
 * One rule per advisory (osv_id as ruleId), one result per mission.
 * composite_score, effort_label, confidence, and score inputs
 * ride in result.properties (transparency-first).
 */

import type { AnalyzeResult, AnalyzedMission } from "../types.js";

const SARIF_SCHEMA = "https://schemastore.azurewebsites.net/schemas/json/sarif-2.1.0.json";
const SARIF_VERSION = "2.1.0";

function severityToSarifLevel(severity: string): "error" | "warning" | "note" | "none" {
  switch (severity.toLowerCase()) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    case "low":
      return "note";
    default:
      return "none";
  }
}

function buildRule(mission: AnalyzedMission) {
  const { advisory } = mission;
  return {
    id: advisory.osv_id,
    name: advisory.osv_id,
    shortDescription: { text: advisory.summary },
    fullDescription: { text: advisory.summary },
    help: {
      text: advisory.summary,
      markdown: `[${advisory.osv_id}](${advisory.url}): ${advisory.summary}\n\nFixed in version: ${advisory.fixed_version ?? "unknown"}`,
    },
    properties: {
      tags: ["security", "vulnerability"],
      severity: advisory.severity,
      cvssScore: advisory.cvss_score,
      fixedVersion: advisory.fixed_version,
    },
  };
}

function buildResult(mission: AnalyzedMission, ruleIndex: number) {
  const { advisory, dependency } = mission;
  const level = severityToSarifLevel(advisory.severity);

  return {
    ruleId: advisory.osv_id,
    ruleIndex,
    level,
    message: {
      text: `${advisory.severity.toUpperCase()}: ${advisory.summary} in ${dependency.package_name}@${dependency.version_spec}`,
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: `package.json`, // We don't have the exact file path in the CLI result
            uriBaseId: "%SRCROOT%",
          },
        },
      },
    ],
    properties: {
      compositeScore: mission.composite_score,
      effortLabel: mission.effort_label,
      confidence: mission.confidence,
      packageName: dependency.package_name,
      versionSpec: dependency.version_spec,
      latestVersion: dependency.latest_version,
      depType: dependency.dep_type,
      isDeprecated: dependency.is_deprecated,
      scoringInputs: {
        impact: mission.scoring_inputs.impact,
        effort: mission.scoring_inputs.effort,
        ecosystemValue: mission.scoring_inputs.ecosystem_value,
      },
    },
  };
}

export function formatSarif(result: AnalyzeResult): string {
  // Collect unique rules (one per advisory OSV ID)
  const ruleMap = new Map<string, AnalyzedMission>();
  for (const mission of result.missions) {
    if (!ruleMap.has(mission.advisory.osv_id)) {
      ruleMap.set(mission.advisory.osv_id, mission);
    }
  }

  const rules = Array.from(ruleMap.values()).map(buildRule);
  const results = result.missions.map((mission) => {
    const ruleIndex = Array.from(ruleMap.keys()).indexOf(mission.advisory.osv_id);
    return buildResult(mission, ruleIndex);
  });

  const sarif = {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: "deptend",
            version: "0.1.2",
            informationUri: "https://deptend.vercel.app",
            rules,
          },
        },
        results,
        // SARIF 2.1.0 enum — must be "utf16CodeUnits" | "unicodeCodePoints".
        // The first cut used "utf16", which passed every local test (the
        // value was asserted verbatim) and failed the REAL contract at the
        // first GitHub code-scanning upload: "instance.runs[0].columnKind
        // is not one of enum values: utf16CodeUnits,unicodeCodePoints".
        // Caught by the #34 scratch-repo round-trip, 2026-11-18.
        columnKind: "utf16CodeUnits",
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}
