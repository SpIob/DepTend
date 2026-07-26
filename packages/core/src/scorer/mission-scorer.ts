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
import {
  compare as pep440Compare,
  explain as pep440Explain,
  valid as pep440Valid,
  validRange as pep440ValidRange,
} from "@renovatebot/pep440";
import type {
  Dependency,
  Advisory,
  Repo,
  EffortLabel,
  ScoreConfidence,
  Ecosystem,
} from "../db/schema.js";
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

// ---------------------------------------------------------------------------
// PEP 440 bump inference — PyPI equivalent of inferSemverBump above
// (ADR 0022, Decision 3)
// ---------------------------------------------------------------------------

/** Operators that establish a lower bound on a PEP 440 specifier clause. */
const PEP440_FLOOR_OPERATORS = new Set(["==", ">=", "~=", ">", "==="]);

/**
 * "operator version" — same shape PEP 440 uses inside a comma-separated
 * specifier, e.g. the two clauses of ">=2.25,<3". Longer operators are
 * listed before their prefixes (">=" before ">", "===" before "==") so the
 * alternation doesn't stop early and leave a stray "=" in the version part.
 */
const PEP440_CLAUSE_RE = /^(===|~=|==|!=|<=|>=|<|>)\s*(.+)$/;

/**
 * Extracts a "current version" proxy from a PEP 440 specifier — the PyPI
 * equivalent of semver.minVersion() above, but hand-rolled rather than
 * pulled from @renovatebot/pep440 itself: the library's own specifier.parse
 * (the function that would normally do this) carries an explicit "have
 * doubts regarding this" comment from its own maintainers and isn't
 * re-exported from the package's public entry point. This only needs
 * comma-splitting plus a single-operator regex — much smaller surface than
 * full range parsing — so it doesn't need that function anyway.
 *
 * When multiple clauses establish a lower bound (rare, but syntactically
 * legal — e.g. ">=1.0,>=2.0"), the most restrictive (highest) one wins,
 * using the library's public, stable compare().
 */
function extractPep440Floor(specifier: string): string | null {
  const clauses = specifier
    .split(",")
    .map((clause) => clause.trim())
    .filter((clause) => clause !== "");

  let floor: string | null = null;

  for (const clause of clauses) {
    const match = PEP440_CLAUSE_RE.exec(clause);
    if (match === null) continue;

    const [, operator, rawVersion] = match;
    if (
      operator === undefined ||
      rawVersion === undefined ||
      !PEP440_FLOOR_OPERATORS.has(operator)
    ) {
      continue;
    }

    // valid() rejects wildcard forms like the version half of "==1.4.*",
    // which isn't a usable single-version floor — skip rather than guess.
    const version = pep440Valid(rawVersion.trim());
    if (version === null) continue;

    if (floor === null || pep440Compare(version, floor) > 0) {
      floor = version;
    }
  }

  return floor;
}

function releaseTriple(release: number[]): [number, number, number] {
  return [release[0] ?? 0, release[1] ?? 0, release[2] ?? 0];
}

/**
 * PEP 440 equivalent of inferSemverBump above — same estimate-not-fact
 * caveat applies (resolved_version is null until lock file parsing lands).
 */
function inferPep440Bump(versionSpec: string, targetVersion: string | null): SemverBump {
  if (targetVersion === null) {
    return "unknown";
  }

  // validRange never throws — safe gate, same role semver.validRange plays
  // above. Note: pep440's validRange("*") is false, unlike node-semver's
  // (which returns the truthy string "*") — that difference is exactly
  // what routes an unconstrained dependency (version_spec "*", set by
  // pypi-parse.ts for a PEP 508 entry with no explicit constraint) to
  // "unknown" here, with no separate special case needed for it.
  if (!pep440ValidRange(versionSpec)) {
    return "unknown";
  }

  const floorRaw = extractPep440Floor(versionSpec);
  if (floorRaw === null) {
    return "unknown";
  }

  // explain() never throws either — returns null on anything unparseable,
  // same safe-gate treatment as validRange above.
  const floor = pep440Explain(floorRaw);
  const target = pep440Explain(targetVersion);
  if (floor === null || target === null) {
    return "unknown";
  }

  // Epoch is PEP 440's highest-precedence ordering component (compared
  // before release segments at all) — a change here is a bigger
  // discontinuity than any release-segment bump, and release-segment
  // comparison alone would never notice it.
  if (floor.epoch !== target.epoch) {
    return "major";
  }

  const [floorMajor, floorMinor, floorPatch] = releaseTriple(floor.release);
  const [targetMajor, targetMinor, targetPatch] = releaseTriple(target.release);

  if (floorMajor !== targetMajor) return "major";
  if (floorMinor !== targetMinor) return "minor";
  if (floorPatch !== targetPatch) return "patch";

  // Release segments identical — could still differ only in pre/post/dev/
  // local segments. Smallest bump category, mirrors inferSemverBump's own
  // "prerelease" -> "patch" mapping above.
  return "patch";
}

/**
 * Which bump-inference function applies for each ecosystem's own version
 * scheme. `go` and `npm` point at the literal same function — Go module
 * versions are real, toolchain-enforced SemVer (sandbox-verified against
 * node-semver during ADR 0024's own grounding: valid(), validRange(), and
 * minVersion() all handle the "v" prefix and Go's version format directly,
 * no wrapper needed), so no new inference function was written for Go at
 * all — see ADR 0024, Decision 3.
 *
 * Record<Ecosystem, ...>, not a ternary — same exhaustiveness guarantee
 * OSV_ECOSYSTEM_NAMES already has in osv.ts. (Found as a real pre-existing
 * gap during ADR 0024's own grounding: this was a two-way
 * `ecosystem === "pypi" ? ... : ...` ternary before Phase 7 — for `go`
 * specifically it happened to already route to the correct function via
 * the `else` branch, but that was incidental, not guaranteed, and gave no
 * compile-time protection against a future ecosystem for which it
 * wouldn't be.)
 */
const BUMP_INFERENCE_BY_ECOSYSTEM: Record<
  Ecosystem,
  (versionSpec: string, targetVersion: string | null) => SemverBump
> = {
  npm: inferSemverBump,
  go: inferSemverBump,
  pypi: inferPep440Bump,
};

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

  const inferBump = BUMP_INFERENCE_BY_ECOSYSTEM[ctx.dependency.ecosystem];
  const semverBump = inferBump(ctx.dependency.versionSpec, targetVersion);

  return {
    semver_bump: semverBump,
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
      "The package registry did not return complete metadata (e.g. latest version) for this package.",
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
