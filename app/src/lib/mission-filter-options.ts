import type { Ecosystem, EffortLabel, MissionType, Severity } from "@deptend/core/db/schema.js";

// Client-agnostic (no "use client"), same reason as mission-board-query.ts.
// Both server pages and client boards consume these. One source of truth
// for each filter axis's option values and display labels: these lists
// were previously duplicated across the two board components, so adding
// a fourth ecosystem meant coordinated edits in two places.

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

export const MISSION_TYPE_OPTIONS: readonly MissionType[] = [
  "vulnerability_fix",
  "dep_update",
  "maintenance",
  "license_issue",
];

export const MISSION_TYPE_LABELS: Record<MissionType, string> = {
  vulnerability_fix: "Vulnerability Fix",
  dep_update: "Dependency Update",
  maintenance: "Maintenance",
  license_issue: "License Issue",
};
