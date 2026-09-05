import { writeFile } from "node:fs/promises";
import type { AnalyzeResult } from "./types.ts";

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

/**
 * Short-form OSV ID for at-a-glance disambiguation in the human summary.
 * Same shape app/src/components/mission-card.tsx#shortOsvId uses (ADR 0051);
 * mirrored CLI-side so two advisories on the same package at the same
 * severity don't render as visually identical rows in the human summary.
 * Local copy rather than an import because /core intentionally doesn't
 * re-export scorer helpers (see packages/core/src/index.ts), and shipping
 * a sibling JSON field would silently change downstream consumers'
 * `title` keys.
 */
function shortOsvId(osvId: string): string | null {
  const parts = osvId.split("-");
  if (parts.length < 2) return null;
  // The `??` defaults satisfy the template-expressions rule (which rejects
  // string|undefined in template literals under typed-lint). Same shape
  // as the dashboard's shortOsvId (mission-card.tsx:64-73).
  return `${parts[0] ?? ""}-${parts[1] ?? ""}`;
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
        `${colorize(severityColor(severity), useColor)}[${severity}]${RESET(useColor)}` +
          ` ${score} — ${mission.title}${titleSuffix}`,
      );
      lines.push(
        `  effort: ${effortPrefix(mission.effort_label, useColor)}${mission.effort_label}${RESET(useColor)}${confidenceFlag}`,
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

// ponytail: ANSI foreground colors, no dep. Gated on TTY + NO_COLOR above;
// the four-color map is one line. Add more severities by extending
// SEVERITY_COLORS below — exhaustive switch guarantees no silent fall-through.
const ANSI_RESET = "\x1b[0m";
function RESET(useColor: boolean): string {
  return useColor ? ANSI_RESET : "";
}
const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: "\x1b[31m",
  HIGH: "\x1b[31m",
  MEDIUM: "\x1b[33m",
  LOW: "\x1b[32m",
  UNKNOWN: "\x1b[90m",
};

function severityColor(severity: string): string {
  return SEVERITY_COLORS[severity] ?? "";
}

function colorize(prefix: string, useColor: boolean): string {
  return useColor && prefix !== "" ? prefix : "";
}

// ponytail: effort_label rendering — trivial/low look identical at the same
// width (audit 2026-09-05 B9). Prefix a one-character glyph so the human
// eye can tell them apart at a glance without adding a second column.
// Color is bonus; the glyph is the load-bearing fix.
const EFFORT_GLYPH: Record<string, string> = {
  trivial: "·",
  low: "+",
  medium: "*",
  high: "×",
};

function effortPrefix(effortLabel: string, useColor: boolean): string {
  const glyph = EFFORT_GLYPH[effortLabel] ?? " ";
  const color = useColor ? effortColor(effortLabel) : "";
  return `${color}${glyph} `;
}

function effortColor(effortLabel: string): string {
  switch (effortLabel) {
    case "trivial":
      return "\x1b[90m"; // dim
    case "low":
      return "\x1b[32m"; // green
    case "medium":
      return "\x1b[33m"; // yellow
    case "high":
      return "\x1b[31m"; // red
    default:
      return "";
  }
}
