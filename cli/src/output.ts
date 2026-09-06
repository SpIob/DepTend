import { writeFile } from "node:fs/promises";
import type { AnalyzeResult } from "./types.js";
import { shortOsvId } from "./format/short-osv-id.js";
import { severityColor, colorize, reset } from "./format/ansi.js";
import { effortPrefix } from "./format/effort-glyph.js";

export interface OutputOptions {
  /** File path to write full JSON to. If null, JSON is not written to disk. */
  outputPath: string | null;
  /** Print raw JSON to stdout instead of the human-readable summary. */
  json: boolean;
}

/**
 * Writes the analysis result per the requested output mode:
 *   --output <file>  always writes full JSON there, plus a short stdout
 *                     confirmation so the run isn't silent.
 *   --json            (no --output) prints full JSON to stdout, for piping.
 *   (neither)          prints a human-readable summary to stdout.
 */
export async function writeOutput(result: AnalyzeResult, options: OutputOptions): Promise<void> {
  const json = JSON.stringify(result, null, 2);

  if (options.outputPath !== null) {
    await writeFile(options.outputPath, json + "\n", "utf-8");
    console.log(`✓ Wrote ${String(result.missions.length)} mission(s) to ${options.outputPath}`);
    return;
  }

  if (options.json) {
    process.stdout.write(json + "\n");
    return;
  }

  console.log(formatHumanSummary(result));
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
