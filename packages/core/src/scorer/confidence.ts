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
  // Only set advisory-derived flags for vulnerability_fix missions.
  // For dep_update/maintenance/license_issue missions there is no advisory,
  // so cvss_score_missing and fixed_version_unknown would be structurally
  // true and cap confidence at "low" — which contradicts ADR 0061's stated
  // consequence that dep_update can reach "medium".
  if (ctx.missionType === "vulnerability_fix") {
    if (ctx.advisory.cvssScore === null) {
      flags.cvss_score_missing = true;
    }
    if (ctx.advisory.fixedVersion === null) {
      flags.fixed_version_unknown = true;
    }
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

export function buildConfidenceNotes(ctx: MissionScoringContext): string[] {
  const flags = deriveConfidenceFlags(ctx);
  const notes: string[] = [];

  if (flags.no_lock_file === true) {
    notes.push(
      "The currently-installed version is estimated from this dependency's declared range rather than confirmed from a lock file (ADR 0038 covers most formats; pnpm and unparseable files are the remaining gaps).",
    );
  }
  // Advisory-derived notes only for vulnerability_fix missions.
  if (ctx.missionType === "vulnerability_fix") {
    if (flags.cvss_score_missing === true) {
      notes.push(
        "No CVSS score was available for this advisory; the impact score falls back to a severity-based estimate.",
      );
    }
    if (flags.fixed_version_unknown === true) {
      notes.push("No fixed version is published for this advisory yet.");
    }
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
  if (ctx.matchMethod === "version_spec") {
    notes.push(
      "This advisory was matched against the package's declared version range rather than a lock-file-resolved version. It may not affect the currently-installed version.",
    );
  }

  return notes;
}
