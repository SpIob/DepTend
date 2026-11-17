import { writeFile } from "node:fs/promises";
import type { AnalyzeResult, AnalyzedMission } from "./types.js";
import { shortOsvId } from "./format/short-osv-id.js";
import { severityColor, colorize, reset } from "./format/ansi.js";
import { effortPrefix } from "./format/effort-glyph.js";
import { formatSarif } from "./format/sarif.js";
import { formatMarkdown } from "./format/markdown.js";

export type OutputFormat = "human" | "json" | "sarif" | "markdown";

export interface OutputOptions {
  /** File path to write full JSON to. If null, JSON is not written to disk. */
  outputPath: string | null;
  /** Print raw JSON to stdout instead of the human-readable summary. */
  json: boolean;
  /** Output format: human, json, sarif, markdown. --json and --output still work for back-compat. */
  format: OutputFormat;
  /** Optional diff result from --baseline comparison. */
  diff?: {
    added: AnalyzedMission[];
    resolved: AnalyzedMission[];
    unchanged: AnalyzedMission[];
  };
}

/**
 * Writes the analysis result per the requested output mode:
 *   --output <file>  always writes the formatted output there, plus a short stdout
 *                     confirmation so the run isn't silent.
 *   --json            (no --output) prints full JSON to stdout, for piping.
 *   --format human|json|sarif|markdown
 *                     (no --output) prints the selected format to stdout.
 *   (neither)         prints a human-readable summary to stdout.
 */
export async function writeOutput(result: AnalyzeResult, options: OutputOptions): Promise<void> {
  const { outputPath, json, format, diff } = options;

  // Generate the requested output format
  let outputContent: string;
  switch (format) {
    case "json": {
      // Include diff in JSON output if present
      const jsonResult = diff ? { ...result, diff } : result;
      outputContent = JSON.stringify(jsonResult, null, 2);
      break;
    }
    case "sarif":
      outputContent = formatSarif(result);
      break;
    case "markdown":
      outputContent = formatMarkdown(result);
      break;
    case "human":
    default:
      outputContent = formatHumanSummary(result);
      break;
  }

  if (outputPath !== null) {
    await writeFile(outputPath, outputContent + "\n", "utf-8");
    console.log(`✓ Wrote ${String(result.missions.length)} mission(s) to ${outputPath}`);
    return;
  }

  if (json && format === "human") {
    // Back-compat: --json without --format prints JSON to stdout
    const jsonResult = diff ? { ...result, diff } : result;
    process.stdout.write(JSON.stringify(jsonResult, null, 2) + "\n");
    return;
  }

  // Print the selected format to stdout
  // Use console.log for human format to maintain test compatibility
  if (format === "human") {
    console.log(outputContent);
  } else {
    process.stdout.write(outputContent + "\n");
  }
}

function formatHumanSummary(result: AnalyzeResult): string {
  const lines: string[] = [];
  const useColor = process.stderr.isTTY && process.env.NO_COLOR === undefined;

  lines.push(`${result.repo.owner}/${result.repo.name}`);
  lines.push(
    `${String(result.dependencies_scanned)} ${result.ecosystem} dependencies scanned` +
      (result.lock_file_present ? "" : " (no lock file — confidence is lower)"),
  );
  lines.push("");

  if (result.missions.length === 0) {
    lines.push("No open vulnerability missions found.");
  } else {
    lines.push(`${String(result.missions.length)} mission(s), highest priority first:`);
    lines.push("");

    for (const mission of result.missions) {
      const severity = mission.advisory.severity.toUpperCase();
      const score = mission.composite_score.toFixed(1);
      const confidenceFlag = mission.confidence === "low" ? " ⚠ low confidence" : "";
      const osvShort = shortOsvId(mission.advisory.osv_id);
      const titleSuffix = osvShort !== null ? ` (${osvShort})` : "";

      lines.push(
        `${colorize(severityColor(severity), useColor)}[${severity}]${reset(useColor)}` +
          ` ${score} — ${mission.title}${titleSuffix}`,
      );
      lines.push(
        `  effort: ${effortPrefix(mission.effort_label, useColor)}${mission.effort_label}${reset(useColor)}${confidenceFlag}`,
      );
      if (mission.action_hint !== null) {
        lines.push(`  → ${mission.action_hint}`);
      }
      lines.push("");
    }
  }

  if (result.warnings.length > 0) {
    lines.push(`${String(result.warnings.length)} warning(s):`);
    for (const warning of result.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  return lines.join("\n");
}
