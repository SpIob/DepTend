/**
 * Confidence derivation — flags, level, and human-readable notes
 *
 * ADR: docs/adr/0006-scoring-algorithm.md (confidence tiers),
 *      docs/adr/0007-mission-score-writing.md (§6),
 *      docs/adr/0029-breaking-change-signals.md (Decision 4),
 *      docs/adr/0032-downstream-dependents.md,
 *      docs/adr/0038-lock-file-resolution.md
 */

import type { ConfidenceFlags } from "../db/json-types.js";
import type { ScoreConfidence } from "../db/schema.js";
import type { MissionScoringContext } from "./mission-scorer.js";

export function deriveConfidenceFlags(ctx: MissionScoringContext): ConfidenceFlags {
  const flags: ConfidenceFlags = {};

  if (ctx.dependency.resolvedVersion === null) {
    flags.no_lock_file = true;
  }
  if (ctx.advisory.cvssScore === null) {
    flags.cvss_score_missing = true;
  }
  if (ctx.advisory.fixedVersion === null) {
    flags.fixed_version_unknown = true;
  }
  if (ctx.dependency.latestVersion === null) {
    flags.registry_metadata_incomplete = true;
  }

  if (ctx.downstreamDependents === undefined) {
    flags.downstream_dependents_unavailable = true;
  }

  if (!ctx.effortSignals?.source_available) {
    flags.breaking_change_signals_unavailable = true;
  }

  return flags;
}

export function deriveConfidence(flags: ConfidenceFlags): ScoreConfidence {
  const flagCount = Object.values(flags).filter((value) => value === true).length;
  if (flagCount === 0) return "high";
  if (flagCount === 1) return "medium";
  return "low";
}

export function buildConfidenceNotes(flags: ConfidenceFlags): string[] {
  const notes: string[] = [];

  if (flags.no_lock_file === true) {
    notes.push(
      "The currently-installed version is estimated from this dependency's declared range rather than confirmed from a lock file (ADR 0038 covers most formats; pnpm and unparseable files are the remaining gaps).",
    );
  }
  if (flags.cvss_score_missing === true) {
    notes.push(
      "No CVSS score was available for this advisory; the impact score falls back to a severity-based estimate.",
    );
  }
  if (flags.fixed_version_unknown === true) {
    notes.push("No fixed version is published for this advisory yet.");
  }
  if (flags.registry_metadata_incomplete === true) {
    notes.push(
      "The package registry did not return complete metadata (e.g. latest version) for this package.",
    );
  }
  if (flags.downstream_dependents_unavailable === true) {
    notes.push(
      "The number of packages depending on this repo's published package couldn't be checked, so ecosystem value is based on stars and issue activity only.",
    );
  }
  if (flags.breaking_change_signals_unavailable === true) {
    notes.push(
      "Changelog and migration-guide data wasn't available for this dependency's own upstream repository, so the effort estimate is based on the semver version bump alone.",
    );
  }

  return notes;
}
