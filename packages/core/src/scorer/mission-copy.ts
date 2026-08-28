/**
 * Mission copy generation
 *
 * Produces the plain-language title / description / action_hint shown to
 * users for all mission types. Deterministic templates only — no
 * LLM call at runtime, which would be a new paid dependency and a source of
 * non-determinism this project's transparency-first constraint doesn't want.
 *
 * Wording pass (2026-07-30, pre-launch): this file was an intentional first
 * draft since Phase 2 (ADR 0007 §5), shipped user-facing since Phase 3
 * without ever getting the design pass that was flagged as owed. This is
 * that pass. The underlying data shown is unchanged — same fields, same
 * test-visible substrings — only the prose and two small additions:
 * (1) the ecosystem is now named explicitly, since npm/PyPI/Go all coexist
 * on the board since ADR 0024 and nothing in the copy previously said which
 * one a mission was about; (2) action_hint now leads with effort_label
 * alongside the semver/PEP440 bump, so "how big a deal is this" reads in
 * one line without opening the score disclosure. Still not a settled
 * decision the way ADR 0006/0007 are — wording remains free to edit.
 *
 * Extended to support multiple mission types (dep_update, maintenance, license_issue)
 * in addition to vulnerability_fix.
 *
 * ADR: docs/adr/0008-mission-db-writer.md
 */

import type { Ecosystem, MissionType } from "../db/schema.js";
import type { MissionScoringContext, MissionScoreComputation } from "./mission-scorer.js";

export interface MissionCopy {
  title: string;
  description: string;
  action_hint: string | null;
}

// Display casing per ecosystem. Deliberately a local, independent copy of
// the same map that already exists in osv.ts (OSV_ECOSYSTEM_NAMES) and
// app/src/components/mission-filter-bar.tsx (ECOSYSTEM_LABELS) rather than
// a shared import — this module has no other dependency on app-side UI
// code, and osv.ts's version means something different (OSV's own wire
// casing, not a display label). A Record<Ecosystem, string> means a fourth
// ecosystem without an entry here is a compile error, not a silent gap.
const ECOSYSTEM_LABELS: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
  go: "Go",
};

function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

// Only "unknown" among the 5 severity enum values starts with a vowel sound.
// Hardcoded rather than a general vowel-detection heuristic — not worth the
// generality for a closed, 5-value enum.
function articleFor(severity: string): string {
  return severity === "unknown" ? "an" : "a";
}

function buildVulnerabilityFixTitle(ctx: MissionScoringContext): string {
  const { dependency, advisory } = ctx;

  if (advisory.fixedVersion !== null) {
    return `Update ${dependency.packageName} to fix ${articleFor(advisory.severity)} ${advisory.severity} vulnerability`;
  }
  return `${capitalize(advisory.severity)} vulnerability in ${dependency.packageName} has no fix yet`;
}

function buildVulnerabilityFixDescription(ctx: MissionScoringContext): string {
  const { dependency, advisory } = ctx;

  const cvssPart = advisory.cvssScore !== null ? ` (CVSS ${advisory.cvssScore.toFixed(1)})` : "";
  const ecosystemLabel = ECOSYSTEM_LABELS[dependency.ecosystem];

  return [
    advisory.summary,
    "",
    `${dependency.packageName} is declared as "${dependency.versionSpec}" and used as a ` +
      `${dependency.depType} ${ecosystemLabel} dependency of this repo. Severity: ` +
      `${advisory.severity}${cvssPart}.`,
    `Reported via ${advisory.osvId} (${advisory.source.toUpperCase()}).`,
  ].join("\n");
}

function buildVulnerabilityFixActionHint(
  ctx: MissionScoringContext,
  score: MissionScoreComputation,
): string | null {
  const { dependency, advisory } = ctx;

  if (advisory.fixedVersion === null) {
    return (
      `No fixed version has been published yet for ${advisory.osvId} — track the ` +
      `advisory and revisit once one lands.`
    );
  }

  const bump = score.effort_inputs.semver_bump;
  const bumpDescriptor = bump === "unknown" ? "bump size unknown" : `${bump} version bump`;

  return (
    `Upgrade ${dependency.packageName} to ${advisory.fixedVersion} or later — ` +
    `${score.effort_label} effort (${bumpDescriptor}).`
  );
}

function buildDepUpdateTitle(ctx: MissionScoringContext, targetVersion: string): string {
  const { dependency } = ctx;
  return `Update ${dependency.packageName} to ${targetVersion} (no known vulnerabilities)`;
}

function buildDepUpdateDescription(ctx: MissionScoringContext, targetVersion: string): string {
  const { dependency } = ctx;
  const ecosystemLabel = ECOSYSTEM_LABELS[dependency.ecosystem];

  return [
    `${dependency.packageName} is declared as "${dependency.versionSpec}" and used as a ` +
      `${dependency.depType} ${ecosystemLabel} dependency of this repo.`,
    `Latest version is ${targetVersion}. No known vulnerabilities in current version.`,
    `Consider updating to stay current with bug fixes and improvements.`,
  ].join("\n");
}

function buildDepUpdateActionHint(
  ctx: MissionScoringContext,
  score: MissionScoreComputation,
  targetVersion: string,
): string | null {
  const { dependency } = ctx;
  const bump = score.effort_inputs.semver_bump;
  const bumpDescriptor = bump === "unknown" ? "bump size unknown" : `${bump} version bump`;

  return (
    `Upgrade ${dependency.packageName} to ${targetVersion} or later — ` +
    `${score.effort_label} effort (${bumpDescriptor}).`
  );
}

function buildMaintenanceTitle(ctx: MissionScoringContext, reason: string): string {
  const { dependency } = ctx;
  return `${capitalize(reason)} package: ${dependency.packageName} needs attention`;
}

function buildMaintenanceDescription(ctx: MissionScoringContext, reason: string): string {
  const { dependency } = ctx;
  const ecosystemLabel = ECOSYSTEM_LABELS[dependency.ecosystem];

  const reasonText =
    reason === "archived"
      ? "This package's upstream repository has been archived and is no longer maintained."
      : reason === "deprecated"
        ? "This package has been deprecated by its maintainers."
        : "This package appears to be unmaintained.";

  return [
    `${dependency.packageName} is declared as "${dependency.versionSpec}" and used as a ` +
      `${dependency.depType} ${ecosystemLabel} dependency of this repo.`,
    reasonText,
    `Consider migrating to an actively maintained alternative.`,
  ].join("\n");
}

function buildMaintenanceActionHint(
  ctx: MissionScoringContext,
  _score: MissionScoreComputation,
  targetVersion: string | undefined,
): string | null {
  const { dependency } = ctx;

  if (targetVersion !== undefined) {
    return `Review ${dependency.packageName} and consider updating to ${targetVersion} or finding an alternative.`;
  }
  return `Review ${dependency.packageName} and consider finding an actively maintained alternative.`;
}

function buildLicenseIssueTitle(ctx: MissionScoringContext): string {
  const { dependency } = ctx;
  return `License issue with ${dependency.packageName}`;
}

function buildLicenseIssueDescription(ctx: MissionScoringContext): string {
  const { dependency } = ctx;
  const ecosystemLabel = ECOSYSTEM_LABELS[dependency.ecosystem];

  return [
    `${dependency.packageName} is declared as "${dependency.versionSpec}" and used as a ` +
      `${dependency.depType} ${ecosystemLabel} dependency of this repo.`,
    `A potential license compatibility issue has been detected.`,
    `Review the package's license terms for compliance with your project's policies.`,
  ].join("\n");
}

function buildLicenseIssueActionHint(
  _ctx: MissionScoringContext,
  _score: MissionScoreComputation,
): string | null {
  return `Review the license terms and determine if action is needed.`;
}

export interface MissionCopyInput {
  type: MissionType;
  ctx: MissionScoringContext;
  score: MissionScoreComputation;
  targetVersion?: string;
  maintenanceReason?: "deprecated" | "archived" | "unmaintained";
}

/**
 * Generate mission copy for all mission types.
 * Supports both legacy (ctx, score) signature for vulnerability_fix
 * and new MissionCopyInput signature for all types.
 */
export function generateMissionCopy(
  arg1: MissionScoringContext | MissionCopyInput,
  arg2?: MissionScoreComputation,
): MissionCopy {
  // Old signature: (ctx, score) -> vulnerability_fix
  if (arg2 !== undefined) {
    return generateMissionCopy({
      type: "vulnerability_fix",
      ctx: arg1 as MissionScoringContext,
      score: arg2,
    });
  }

  // New signature: MissionCopyInput
  const input = arg1 as MissionCopyInput;
  const { type, ctx, score, targetVersion, maintenanceReason } = input;

  switch (type) {
    case "vulnerability_fix":
      return {
        title: buildVulnerabilityFixTitle(ctx),
        description: buildVulnerabilityFixDescription(ctx),
        action_hint: buildVulnerabilityFixActionHint(ctx, score),
      };
    case "dep_update":
      return {
        title: buildDepUpdateTitle(ctx, targetVersion ?? "latest"),
        description: buildDepUpdateDescription(ctx, targetVersion ?? "latest"),
        action_hint: buildDepUpdateActionHint(ctx, score, targetVersion ?? "latest"),
      };
    case "maintenance":
      return {
        title: buildMaintenanceTitle(ctx, maintenanceReason ?? "unmaintained"),
        description: buildMaintenanceDescription(ctx, maintenanceReason ?? "unmaintained"),
        action_hint: buildMaintenanceActionHint(ctx, score, targetVersion),
      };
    case "license_issue":
      return {
        title: buildLicenseIssueTitle(ctx),
        description: buildLicenseIssueDescription(ctx),
        action_hint: buildLicenseIssueActionHint(ctx, score),
      };
    default: {
      // Exhaustiveness check - TypeScript will error if a new MissionType is added
      const _exhaustive: never = type;
      throw new Error(`Unhandled mission type: ${String(_exhaustive)}`);
    }
  }
}
