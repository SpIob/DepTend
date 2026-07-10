/**
 * Mission copy generation
 *
 * Produces the plain-language title / description / action_hint shown to
 * users for a vulnerability_fix mission. Deterministic templates only — no
 * LLM call at runtime, which would be a new paid dependency and a source of
 * non-determinism this project's transparency-first constraint doesn't want.
 *
 * This is a first draft. Unlike the scoring formulas, wording is a matter of
 * taste, not correctness — treat this as a starting point to edit freely,
 * not a settled decision the way ADR 0006/0007 are.
 *
 * ADR: docs/adr/0008-mission-db-writer.md
 */

import type { MissionScoringContext, MissionScoreComputation } from "./mission-scorer.js";

export interface MissionCopy {
  title: string;
  description: string;
  action_hint: string | null;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

function buildTitle(ctx: MissionScoringContext): string {
  const { dependency, advisory } = ctx;

  if (advisory.fixedVersion !== null) {
    return `Update ${dependency.packageName} to fix a ${advisory.severity} vulnerability`;
  }
  return `${capitalize(advisory.severity)} vulnerability in ${dependency.packageName} has no fix yet`;
}

function buildDescription(ctx: MissionScoringContext): string {
  const { dependency, advisory } = ctx;

  const cvssPart = advisory.cvssScore !== null ? ` (CVSS ${advisory.cvssScore.toFixed(1)})` : "";

  return [
    advisory.summary,
    "",
    `Affects ${dependency.packageName} (declared as "${dependency.versionSpec}"), used as a ` +
      `${dependency.depType} dependency of this repo. Severity: ${advisory.severity}${cvssPart}.`,
    `Source: ${advisory.osvId} (${advisory.source.toUpperCase()}).`,
  ].join("\n");
}

function buildActionHint(
  ctx: MissionScoringContext,
  score: MissionScoreComputation,
): string | null {
  const { dependency, advisory } = ctx;

  if (advisory.fixedVersion === null) {
    return `No fixed version has been published yet for ${advisory.osvId}. Track upstream for a fix.`;
  }

  const bump = score.effort_inputs.semver_bump;
  const bumpPart = bump === "unknown" ? "version bump size unknown" : `${bump} version bump`;

  return `Upgrade ${dependency.packageName} to ${advisory.fixedVersion} or later (${bumpPart}).`;
}

export function generateMissionCopy(
  ctx: MissionScoringContext,
  score: MissionScoreComputation,
): MissionCopy {
  return {
    title: buildTitle(ctx),
    description: buildDescription(ctx),
    action_hint: buildActionHint(ctx, score),
  };
}
