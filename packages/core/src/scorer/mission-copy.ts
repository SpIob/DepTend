/**
 * Mission copy generation
 *
 * Produces the plain-language title / description / action_hint shown to
 * users for a vulnerability_fix mission. Deterministic templates only — no
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
 * ADR: docs/adr/0008-mission-db-writer.md
 */

import type { Ecosystem } from "../db/schema.js";
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

function buildTitle(ctx: MissionScoringContext): string {
  const { dependency, advisory } = ctx;

  if (advisory.fixedVersion !== null) {
    return `Update ${dependency.packageName} to fix ${articleFor(advisory.severity)} ${advisory.severity} vulnerability`;
  }
  return `${capitalize(advisory.severity)} vulnerability in ${dependency.packageName} has no fix yet`;
}

function buildDescription(ctx: MissionScoringContext): string {
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

function buildActionHint(
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
