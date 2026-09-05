/**
 * Mission copy generation
 *
 * Produces the plain-language title / description / action_hint shown to
 * users for all mission types. Deterministic templates only — no
 * LLM call at runtime, which would be a new paid dependency and a source of
 * non-determinism this project's transparency-first constraint doesn't want.
 *
 * Data-driven template approach: each mission type defines its own template
 * functions, reducing code duplication across the 4 mission types.
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

const ECOSYSTEM_LABELS: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
  go: "Go",
};

function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

function articleFor(severity: string): string {
  return severity === "unknown" ? "an" : "a";
}

function bumpDescriptor(bump: string): string {
  return bump === "unknown" ? "bump size unknown" : `${bump} version bump`;
}

function ecosystemLine(ctx: MissionScoringContext): string {
  const { dependency } = ctx;
  const label = ECOSYSTEM_LABELS[dependency.ecosystem];
  return `${dependency.packageName} is declared as "${dependency.versionSpec}" and used as a ${dependency.depType} ${label} dependency of this repo.`;
}

function severityLine(ctx: MissionScoringContext): string {
  const { advisory } = ctx;
  const cvssPart = advisory.cvssScore !== null ? ` (CVSS ${advisory.cvssScore.toFixed(1)})` : "";
  return `Severity: ${advisory.severity}${cvssPart}.`;
}

function osvLine(ctx: MissionScoringContext): string {
  const { advisory } = ctx;
  return `Reported via ${advisory.osvId} (${advisory.source.toUpperCase()}).`;
}

interface MissionCopyTemplate {
  title: (ctx: MissionScoringContext, params: MissionCopyParams) => string;
  description: (ctx: MissionScoringContext, params: MissionCopyParams) => string;
  action_hint: (
    ctx: MissionScoringContext,
    score: MissionScoreComputation,
    params: MissionCopyParams,
  ) => string | null;
}

interface MissionCopyParams {
  targetVersion: string | undefined;
  maintenanceReason: "deprecated" | "archived" | "unmaintained" | undefined;
}

function reasonText(reason: string): string {
  return reason === "archived"
    ? "This package's upstream repository has been archived and is no longer maintained."
    : reason === "deprecated"
      ? "This package has been deprecated by its maintainers."
      : "This package appears to be unmaintained.";
}

const TEMPLATES: Record<MissionType, MissionCopyTemplate> = {
  vulnerability_fix: {
    title: (ctx) => {
      const { dependency, advisory } = ctx;
      if (advisory.fixedVersion !== null) {
        return `Update ${dependency.packageName} to fix ${articleFor(advisory.severity)} ${advisory.severity} vulnerability`;
      }
      return `${capitalize(advisory.severity)} vulnerability in ${dependency.packageName} has no fix yet`;
    },
    description: (ctx) =>
      [ctx.advisory.summary, "", `${ecosystemLine(ctx)} ${severityLine(ctx)}`, osvLine(ctx)].join(
        "\n",
      ),
    action_hint: (ctx, score) => {
      const { dependency, advisory } = ctx;
      if (advisory.fixedVersion === null) {
        return `No fixed version has been published yet for ${advisory.osvId} — track the advisory and revisit once one lands.`;
      }
      return `Upgrade ${dependency.packageName} to ${advisory.fixedVersion} or later — ${score.effort_label} effort (${bumpDescriptor(score.effort_inputs.semver_bump)}).`;
    },
  },
  dep_update: {
    title: (ctx, params) => {
      const { dependency } = ctx;
      return `Update ${dependency.packageName} to ${params.targetVersion ?? "latest"} (no known vulnerabilities)`;
    },
    description: (ctx, params) =>
      [
        ecosystemLine(ctx),
        `Latest version is ${params.targetVersion ?? "latest"}. No known vulnerabilities in current version.`,
        "Consider updating to stay current with bug fixes and improvements.",
      ].join("\n"),
    action_hint: (ctx, score, params) => {
      const { dependency } = ctx;
      return `Upgrade ${dependency.packageName} to ${params.targetVersion ?? "latest"} or later — ${score.effort_label} effort (${bumpDescriptor(score.effort_inputs.semver_bump)}).`;
    },
  },
  maintenance: {
    title: (ctx, params) => {
      const { dependency } = ctx;
      return `${capitalize(params.maintenanceReason ?? "unmaintained")} package: ${dependency.packageName} needs attention`;
    },
    description: (ctx, params) =>
      [
        ecosystemLine(ctx),
        reasonText(params.maintenanceReason ?? "unmaintained"),
        "Consider migrating to an actively maintained alternative.",
      ].join("\n"),
    action_hint: (ctx, _score, params) => {
      const { dependency } = ctx;
      if (params.targetVersion !== undefined) {
        return `Review ${dependency.packageName} and consider updating to ${params.targetVersion} or finding an alternative.`;
      }
      return `Review ${dependency.packageName} and consider finding an actively maintained alternative.`;
    },
  },
  license_issue: {
    title: (ctx) => {
      const { dependency } = ctx;
      return `License issue with ${dependency.packageName}`;
    },
    description: (ctx) =>
      [
        ecosystemLine(ctx),
        "A potential license compatibility issue has been detected.",
        "Review the package's license terms for compliance with your project's policies.",
      ].join("\n"),
    action_hint: () => "Review the license terms and determine if action is needed.",
  },
};

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
  const template = TEMPLATES[type as keyof typeof TEMPLATES];

  if (!template) {
    // This should never happen if TEMPLATES covers all MissionType values
    throw new Error(`Unhandled mission type: ${String(type)}`);
  }

  const params: MissionCopyParams = { targetVersion, maintenanceReason };
  return {
    title: template.title(ctx, params),
    description: template.description(ctx, params),
    action_hint: template.action_hint(ctx, score, params),
  };
}
