"use client";

import type { MissionWithScore } from "@deptend/core";

export interface MissionMarkdownRow {
  severity: string;
  score: string;
  effort: string;
  packageName: string;
  advisoryLink: string;
  actionHint: string;
  repo: string;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[|]/g, "\\|");
}

function formatAdvisoryLink(advisoryId: string): string {
  if (!advisoryId) return "";
  return `[${advisoryId}](https://osv.dev/vulnerability/${advisoryId})`;
}

export function missionsToMarkdownRows(
  missions: readonly MissionWithScore[],
  includeRepo: boolean,
): MissionMarkdownRow[] {
  return missions.map((mission) => {
    const severity = mission.advisory?.severity ?? "unknown";
    const score = mission.score?.compositeScore?.toFixed(1) ?? "—";
    const effort = mission.score?.effortLabel ?? "unknown";
    const packageName = mission.dependency?.packageName ?? "—";
    const advisoryLink = formatAdvisoryLink(mission.advisory?.osvId ?? "");
    const actionHint = mission.actionHint ?? "—";
    const repo = includeRepo ? `${mission.repo?.owner ?? "—"}/${mission.repo?.name ?? "—"}` : "—";

    return {
      severity: escapeMarkdown(severity),
      score: escapeMarkdown(score),
      effort: escapeMarkdown(effort),
      packageName: escapeMarkdown(packageName),
      advisoryLink,
      actionHint: escapeMarkdown(actionHint),
      repo: escapeMarkdown(repo),
    };
  });
}

export function missionsToMarkdown(
  missions: readonly MissionWithScore[],
  includeRepo: boolean,
): string {
  const rows = missionsToMarkdownRows(missions, includeRepo);
  if (rows.length === 0) return "";

  const headers = includeRepo
    ? ["Severity", "Score", "Effort", "Package", "Advisory", "Action", "Repo"]
    : ["Severity", "Score", "Effort", "Package", "Advisory", "Action"];

  const headerRow = `| ${headers.join(" | ")} |`;
  const separatorRow = `|${headers.map(() => "---").join("|")}|`;

  const dataRows = rows.map((row) => {
    const cells = includeRepo
      ? [
          row.severity,
          row.score,
          row.effort,
          row.packageName,
          row.advisoryLink,
          row.actionHint,
          row.repo ?? "—",
        ]
      : [row.severity, row.score, row.effort, row.packageName, row.advisoryLink, row.actionHint];
    return `| ${cells.join(" | ")} |`;
  });

  return [headerRow, separatorRow, ...dataRows].join("\n");
}

export function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for older browsers / non-secure contexts
  return new Promise((resolve, reject) => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      const success = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (success) resolve();
      else reject(new Error("execCommand('copy') failed"));
    } catch (error) {
      document.body.removeChild(textarea);
      reject(error);
    }
  });
}
