import type { Ecosystem, EffortLabel, Severity } from "@deptend/core/db/schema.js";

// Client-agnostic (no "use client"), same reason as mission-board-query.ts —
// both server pages and client boards consume these. One source of truth for
// each filter axis's option values and display labels: these lists were
// previously triplicated across mission-filter-bar.tsx,
// paginated-mission-board.tsx, and mission-board-query.ts, so adding a
// fourth ecosystem meant three coordinated edits.

export const SEVERITY_OPTIONS: readonly Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "unknown",
];

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  unknown: "Unknown",
};

export const ECOSYSTEM_OPTIONS: readonly Ecosystem[] = ["npm", "pypi", "go"];

export const ECOSYSTEM_LABELS: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
  go: "Go",
};

export const EFFORT_OPTIONS: readonly EffortLabel[] = ["trivial", "low", "medium", "high"];

export const EFFORT_LABELS: Record<EffortLabel, string> = {
  trivial: "Trivial",
  low: "Low",
  medium: "Medium",
  high: "High",
};
