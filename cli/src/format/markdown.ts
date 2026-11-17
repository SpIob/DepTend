/**
 * Markdown output formatter
 *
 * Produces a compact table (severity, score, effort, package, advisory link)
 * + per-mission bullets with action hint. Respects --output.
 */

import type { AnalyzeResult, AnalyzedMission } from "../types.js";

function severityEmoji(severity: string): string {
  switch (severity.toLowerCase()) {
    case "critical":
      return "🔴";
    case "high":
      return "🟠";
    case "medium":
      return "🟡";
    case "low":
      return "🟢";
    default:
      return "⚪";
  }
}

function formatTableRow(mission: AnalyzedMission): string {
  const { advisory, dependency, composite_score, effort_label } = mission;
  const severity = severityEmoji(advisory.severity) + " " + advisory.severity.toUpperCase();
  const score = composite_score.toFixed(1);
  const effort = effort_label.toUpperCase();
  const pkg = `${dependency.package_name}@${dependency.version_spec}`;
  const link = `[${advisory.osv_id}](${advisory.url})`;

  return `| ${severity} | ${score} | ${effort} | ${pkg} | ${link} |`;
}

function formatMissionBullet(mission: AnalyzedMission): string {
  const { advisory, dependency, action_hint, composite_score, effort_label, confidence } = mission;
  const lines: string[] = [];

  lines.push(
    `### ${severityEmoji(advisory.severity)} ${advisory.severity.toUpperCase()} — ${advisory.summary}`,
  );
  lines.push("");
  lines.push(
    `- **Package:** \`${dependency.package_name}\` (spec: \`${dependency.version_spec}\`, latest: \`${dependency.latest_version ?? "unknown"}\`)`,
  );
  lines.push(`- **Advisory:** [${advisory.osv_id}](${advisory.url})`);
  lines.push(
    `- **Severity:** ${advisory.severity.toUpperCase()} (CVSS: ${advisory.cvss_score ?? "N/A"})`,
  );
  lines.push(`- **Fixed version:** ${advisory.fixed_version ?? "unknown"}`);
  lines.push(`- **Composite score:** ${composite_score.toFixed(1)}`);
  lines.push(`- **Effort:** ${effort_label.toUpperCase()}`);
  lines.push(`- **Confidence:** ${confidence.toUpperCase()}`);

  if (action_hint !== null) {
    lines.push(`- **Action:** ${action_hint}`);
  }

  lines.push("");
  return lines.join("\n");
}

export function formatMarkdown(result: AnalyzeResult): string {
  const lines: string[] = [];

  // Header
  lines.push(`# DepTend Analysis: ${result.repo.owner}/${result.repo.name}`);
  lines.push("");
  lines.push(`**Generated:** ${new Date(result.generated_at).toLocaleString()}`);
  lines.push(`**Ecosystem:** ${result.ecosystem}`);
  lines.push(`**Dependencies scanned:** ${result.dependencies_scanned}`);
  lines.push(`**Lock file present:** ${result.lock_file_present ? "Yes" : "No"}`);
  lines.push(`**Missions found:** ${result.missions.length}`);
  lines.push("");

  if (result.missions.length === 0) {
    lines.push("No open vulnerability missions found.");
    lines.push("");

    if (result.warnings.length > 0) {
      lines.push("## Warnings");
      lines.push("");
      for (const warning of result.warnings) {
        lines.push(`- ${warning}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // Summary table
  lines.push("## Mission Summary");
  lines.push("");
  lines.push("| Severity | Score | Effort | Package | Advisory |");
  lines.push("| --- | --- | --- | --- | --- |");

  for (const mission of result.missions) {
    lines.push(formatTableRow(mission));
  }

  lines.push("");

  // Detailed missions
  lines.push("## Mission Details");
  lines.push("");

  for (const mission of result.missions) {
    lines.push(formatMissionBullet(mission));
  }

  // Warnings
  if (result.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
