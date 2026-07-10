/**
 * Mission scoring — input mapping, confidence derivation, composite combination
 *
 * Maps real Dependency / Advisory / Repo rows onto the ImpactInputs /
 * EffortInputs / EcosystemValueInputs shapes the individual scorers expect,
 * derives ConfidenceFlags from what's actually missing in the data, and
 * combines the three scorer results into a single composite score.
 *
 * Phase 2 generates vulnerability_fix missions only — see ADR 0007 for why
 * dep_update / maintenance / license_issue are deferred.
 *
 * ADR: docs/adr/0007-mission-score-writing.md (mapping, confidence, scope)
 *      docs/adr/0006-scoring-algorithm.md (formulas)
 */

import semver from "semver";
import type { Dependency, Advisory, Repo, EffortLabel, ScoreConfidence } from "../db/schema.js";
import type {
  ConfidenceFlags,
  EffortInputs,
  EcosystemValueInputs,
  ImpactInputs,
} from "../db/json-types.js";
import { DefaultImpactScorer } from "./impact.js";
import { DefaultEffortScorer } from "./effort.js";
import { DefaultEcosystemValueScorer } from "./ecosystem-value.js";

export const SCORING_VERSION = "1.0.0";

type SemverBump = EffortInputs["semver_bump"];

/**
 * A dependency confirmed (via dependency_advisories.is_affected) to be
 * affected by the given advisory, plus the repo it belongs to. This
 * function does not re-validate that match — the caller is responsible for
 * only passing already-confirmed pairs.
 */
export interface MissionScoringContext {
  dependency: Dependency;
  advisory: Advisory;
  repo: Repo;
}

export interface MissionScoreComputation {
  impact_score: number;
  ecosystem_value_score: number;
  composite_score: number;
  effort_label: EffortLabel;
  impact_inputs: ImpactInputs;
  ecosystem_value_inputs: EcosystemValueInputs;
  effort_inputs: EffortInputs;
  confidence: ScoreConfidence;
  confidence_notes: string[];
  confidence_flags: ConfidenceFlags;
  scoring_version: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ---------------------------------------------------------------------------
// semver_bump inference (ADR 0007, §4)
// ---------------------------------------------------------------------------

/**
 * Estimates the semver bump size from a declared range to a target version.
 * This is always an estimate, never a confirmed fact — resolved_version is
 * always null until lock file parsing lands (see ADR 0007, §3), so the
 * "current" side is the minimum version satisfying the declared range, not
 * the version actually installed.
 */
function inferSemverBump(versionSpec: string, targetVersion: string | null): SemverBump {
  if (targetVersion === null) {
    return "unknown";
  }

  // validRange never throws, unlike minVersion — use it as a safe gate.
  // "*" (and "", which normalizes to "*") carries no real version
  // information; treating it as 0.0.0 would fabricate a "major bump"
  // signal for nearly every target. Better to say we don't know.
  const normalizedRange = semver.validRange(versionSpec);
  if (normalizedRange === null || normalizedRange === "*") {
    return "unknown";
  }

  let currentProxy: semver.SemVer | null;
  try {
    currentProxy = semver.minVersion(versionSpec);
  } catch {
    return "unknown";
  }
  if (currentProxy === null) {
    return "unknown";
  }

  const coercedTarget = semver.coerce(targetVersion);
  if (coercedTarget === null) {
    return "unknown";
  }

  const diff = semver.diff(currentProxy.version, coercedTarget.version);

  switch (diff) {
    case "major":
    case "premajor":
      return "major";
    case "minor":
    case "preminor":
      return "minor";
    case "patch":
    case "prepatch":
    case "prerelease":
      return "patch";
    case null:
      return "unknown";
    default:
      return "unknown";
  }
}

function daysSince(date: Date | null): number | null {
  if (date === null) {
    return null;
  }
  const ms = Date.now() - date.getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Input mapping (ADR 0007)
// ---------------------------------------------------------------------------

export function buildImpactInputs(ctx: MissionScoringContext): ImpactInputs {
  return {
    cvss_score: ctx.advisory.cvssScore,
    severity: ctx.advisory.severity,
    // Phase 1/2 only ingests direct dependencies — see ADR 0007, §2.
    is_transitive: false,
    dep_type: ctx.dependency.depType,
    days_since_advisory: daysSince(ctx.advisory.publishedAt),
  };
}

export function buildEffortInputs(ctx: MissionScoringContext): EffortInputs {
  const targetVersion = ctx.advisory.fixedVersion ?? ctx.dependency.latestVersion;

  return {
    semver_bump: inferSemverBump(ctx.dependency.versionSpec, targetVersion),
    // No data source ingested yet — see ADR 0007, §5.
    has_migration_guide: false,
    breaking_change_signals: [],
  };
}

export function buildEcosystemValueInputs(ctx: MissionScoringContext): EcosystemValueInputs {
  return {
    repo_stars: ctx.repo.stars,
    open_issues_count: ctx.repo.openIssuesCount,
    // No data source ingested yet — see ADR 0006.
    downstream_dependents: null,
  };
}

// ---------------------------------------------------------------------------
// Confidence (ADR 0006 §"Confidence", ADR 0007 §6)
// ---------------------------------------------------------------------------

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

  // Always true in Phase 2 — no data source ingested yet for either.
  flags.downstream_dependents_unavailable = true;
  flags.breaking_change_signals_unavailable = true;

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
      "No lock file was parsed for this dependency, so the currently-installed version is estimated from its declared range rather than confirmed.",
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
      "The npm registry did not return complete metadata (e.g. latest version) for this package.",
    );
  }
  if (flags.downstream_dependents_unavailable === true) {
    notes.push(
      "The number of packages that depend on this one isn't tracked yet, so ecosystem value is based on stars and issue activity only.",
    );
  }
  if (flags.breaking_change_signals_unavailable === true) {
    notes.push(
      "Changelog and migration-guide data isn't ingested yet, so the effort estimate is based on the semver version bump alone.",
    );
  }

  return notes;
}

// ---------------------------------------------------------------------------
// Composite orchestration
// ---------------------------------------------------------------------------

const impactScorer = new DefaultImpactScorer();
const effortScorer = new DefaultEffortScorer();
const ecosystemValueScorer = new DefaultEcosystemValueScorer();

/**
 * Computes a full mission score from a confirmed (dependency, advisory,
 * repo) context. Pure — performs no I/O. Shaped to spread directly into a
 * MissionScoreInsert alongside a mission_id once the DB-writer step exists.
 */
export function computeMissionScore(ctx: MissionScoringContext): MissionScoreComputation {
  const impactInputs = buildImpactInputs(ctx);
  const effortInputs = buildEffortInputs(ctx);
  const ecosystemValueInputs = buildEcosystemValueInputs(ctx);
  const confidenceFlags = deriveConfidenceFlags(ctx);

  const impactResult = impactScorer.score(impactInputs);
  const effortResult = effortScorer.score(effortInputs);
  const ecosystemValueResult = ecosystemValueScorer.score(ecosystemValueInputs);

  const composite_score = clamp(impactResult.score * 0.6 + ecosystemValueResult.score * 0.4, 0, 10);

  return {
    impact_score: impactResult.score,
    ecosystem_value_score: ecosystemValueResult.score,
    composite_score,
    effort_label: effortResult.label,
    impact_inputs: impactResult.inputs,
    ecosystem_value_inputs: ecosystemValueResult.inputs,
    effort_inputs: effortResult.inputs,
    confidence: deriveConfidence(confidenceFlags),
    confidence_notes: buildConfidenceNotes(confidenceFlags),
    confidence_flags: confidenceFlags,
    scoring_version: SCORING_VERSION,
  };
}
