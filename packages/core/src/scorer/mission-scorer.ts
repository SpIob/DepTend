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
 *      docs/adr/0029-breaking-change-signals.md (effortSignals, Step 4)
 *      docs/adr/0032-downstream-dependents.md (downstreamDependents)
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
// Type-only, and deliberately the first-ever scorer -> ingestor import in
// this codebase (previously zero cross-imports existed in either
// direction). Sound direction, not a layering violation: scorer already
// consumes ingestor-produced *data* (Dependency/Advisory/Repo are rows the
// ingestor writes), so consuming an ingestor-defined *type* for
// externally-prefetched signals follows the same data flow. See ADR 0029
// Decision 2 — computeMissionScore() itself stays synchronous/pure; only
// the type is imported here, no function from changelog-signals.ts.
import type { EffortSignals } from "../ingestor/changelog-signals.js";
import { DefaultImpactScorer } from "./impact.js";
import { DefaultEffortScorer } from "./effort.js";
import { DefaultEcosystemValueScorer } from "./ecosystem-value.js";

export const SCORING_VERSION = "1.1.0";

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
  /**
   * Prefetched breaking-change/migration-guide signals for this
   * dependency's own upstream repo (ADR 0029) — undefined means "the
   * caller never attempted this," treated identically to a resolved
   * `source_available: false`. Always undefined before Step 5 wires the
   * writer.ts prefetch in; buildEffortInputs()/deriveConfidenceFlags()
   * both already handle its absence, so this addition doesn't break any
   * existing caller (CLI's analyze.ts, scorer/writer.test.ts fixtures)
   * before that step lands.
   */
  effortSignals?: EffortSignals;
  /**
   * Prefetched downstream-dependent count for the *analyzed repo's* own
   * published package(s) (ADR 0032) — undefined means "the caller never
   * attempted it," or attempted and couldn't resolve a published package
   * (no key, unknown to libraries.io, fetch failed). Both keep
   * downstream_dependents null and downstream_dependents_unavailable set,
   * identical to pre-ADR-0032 behavior. A present value — including a
   * genuine 0 — is real, checked data: the flag clears and the ecosystem
   * value scorer's with-downstream weighting applies.
   */
  downstreamDependents?: number;
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
 * Extracts a "current version" proxy from a declared semver range — the
 * same floor inferSemverBump() below uses for its own bump-size estimate.
 * Split out (rather than left inline, as it was through Step 4) so
 * extractVersionFloor() can reuse it without duplicating the logic —
 * mirrors extractPep440Floor()'s already-separate shape below.
 */
function extractSemverFloor(versionSpec: string): string | null {
  // validRange never throws, unlike minVersion — use it as a safe gate.
  // "*" (and "", which normalizes to "*") carries no real version
  // information; treating it as 0.0.0 would fabricate a "major bump"
  // signal for nearly every target. Better to say we don't know.
  const normalizedRange = semver.validRange(versionSpec);
  if (normalizedRange === null || normalizedRange === "*") {
    return null;
  }

  try {
    const currentProxy = semver.minVersion(versionSpec);
    return currentProxy === null ? null : currentProxy.version;
  } catch {
    return null;
  }
}

/**
 * Estimates the semver bump size from a declared range to a target version.
 * This is always an estimate, never a confirmed fact — resolved_version is
 * always null until lock file parsing lands (see ADR 0007, §3), so the
 * "current" side is the minimum version satisfying the declared range, not
 * the version actually installed.
 *
 * If currentVersion is provided (e.g., from a lock file), it is used as the
 * "current" version instead of computing the floor from the version spec.
 * This is the key improvement from ADR 0038.
 */
function inferSemverBump(
  versionSpec: string,
  targetVersion: string | null,
  currentVersion?: string | null,
): SemverBump {
  if (targetVersion === null) {
    return "unknown";
  }

  // Use provided currentVersion (from lock file) or compute floor from versionSpec
  const floor = currentVersion ?? extractSemverFloor(versionSpec);
  if (floor === null) {
    return "unknown";
  }

  const coercedTarget = semver.coerce(targetVersion);
  if (coercedTarget === null) {
    return "unknown";
  }

  const diff = semver.diff(floor, coercedTarget.version);

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
export function extractPep440Floor(specifier: string): string | null {
  const clauses = specifier
    .split(",")
    .map((clause) => clause.trim())
    .filter((clause) => clause !== "");

  let floor: ReturnType<typeof pep440Valid> | null = null;

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
 *
 * If currentVersion is provided (e.g., from a lock file), it is used as the
 * "current" version instead of computing the floor from the version spec.
 * This is the key improvement from ADR 0038.
 */
function inferPep440Bump(
  versionSpec: string,
  targetVersion: string | null,
  currentVersion?: string | null,
): SemverBump {
  if (targetVersion === null) {
    return "unknown";
  }

  // If currentVersion is provided, use it directly; otherwise compute floor from versionSpec
  if (currentVersion !== undefined && currentVersion !== null) {
    const floor = pep440Explain(currentVersion);
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
/**
 * The floor half of each bump-inference function, reused
 * (not duplicated) rather than each function's own internal logic.
 */
const FLOOR_EXTRACTION_BY_ECOSYSTEM: Record<Ecosystem, (versionSpec: string) => string | null> = {
  npm: extractSemverFloor,
  go: extractSemverFloor,
  pypi: extractPep440Floor,
};

/**
 * Extracts a "current version" proxy from a dependency's declared version
 * spec, for the given ecosystem — the exact floor inferSemverBump()/
 * inferPep440Bump() use internally for their own semver_bump estimate.
 *
 * Exported for writer.ts (ADR 0029, Step 5) to bound changelog-signals.ts's
 * GitHub Releases pagination with the same estimate the effort label
 * itself is already built on, rather than a second, possibly-inconsistent
 * one. Not used anywhere else in this module — buildEffortInputs() calls
 * the per-ecosystem bump-inference functions directly, which compute this
 * same floor internally as one step of a larger calculation.
 */
export function extractVersionFloor(ecosystem: Ecosystem, versionSpec: string): string | null {
  return FLOOR_EXTRACTION_BY_ECOSYSTEM[ecosystem](versionSpec);
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
  // is_transitive is true when dep_type is "transitive" (ADR 0038)
  const isTransitive = ctx.dependency.depType === "transitive";
  // For impact scoring, transitive deps use "optional" weight (blast radius)
  const depType = isTransitive ? "optional" : ctx.dependency.depType;
  return {
    cvss_score: ctx.advisory.cvssScore,
    severity: ctx.advisory.severity,
    is_transitive: isTransitive,
    dep_type: depType,
    days_since_advisory: daysSince(ctx.advisory.publishedAt),
    // EPSS exploitability score (ADR 0038) — null when not available
    epss_score: ctx.advisory.epssScore ?? null,
  };
}

export function buildEffortInputs(ctx: MissionScoringContext): EffortInputs {
  const targetVersion = ctx.advisory.fixedVersion ?? ctx.dependency.latestVersion;

  // Use resolved_version as the "current" version when available (ADR 0038),
  // otherwise fall back to the manifest range floor estimate.
  const currentVersion =
    ctx.dependency.resolvedVersion ??
    extractVersionFloor(ctx.dependency.ecosystem, ctx.dependency.versionSpec);

  let semverBump: SemverBump;
  if (currentVersion === null) {
    semverBump = "unknown";
  } else {
    // Call the per-ecosystem inference function with the resolved version as currentVersion
    switch (ctx.dependency.ecosystem) {
      case "npm":
      case "go":
        semverBump = inferSemverBump(ctx.dependency.versionSpec, targetVersion, currentVersion);
        break;
      case "pypi":
        semverBump = inferPep440Bump(ctx.dependency.versionSpec, targetVersion, currentVersion);
        break;
      default:
        semverBump = "unknown";
    }
  }

  return {
    semver_bump: semverBump,
    // ADR 0029: real signal when the caller prefetched one; unchanged
    // false/[] defaults (ADR 0007 §5) when it didn't or nothing resolved.
    has_migration_guide: ctx.effortSignals?.has_migration_guide ?? false,
    breaking_change_signals: ctx.effortSignals?.breaking_change_signals ?? [],
  };
}

export function buildEcosystemValueInputs(ctx: MissionScoringContext): EcosystemValueInputs {
  return {
    repo_stars: ctx.repo.stars,
    open_issues_count: ctx.repo.openIssuesCount,
    // ADR 0032: real count when the caller prefetched one (including a
    // genuine 0); unchanged null default when it didn't or nothing resolved.
    downstream_dependents: ctx.downstreamDependents ?? null,
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

  // ADR 0032: conditional, not unconditional. Set when the caller never
  // attempted the prefetch (downstreamDependents absent — the pre-ADR-0032
  // behavior, and still true for the CLI, which has no API keys by design)
  // or genuinely couldn't resolve the analyzed repo's published package
  // via libraries.io. A repo whose package *did* resolve correctly leaves
  // this unset even when the count is a genuine 0 — "checked, found
  // nothing" is real, higher-confidence information, not a gap (same
  // philosophy as ADR 0029 Decision 4).
  if (ctx.downstreamDependents === undefined) {
    flags.downstream_dependents_unavailable = true;
  }

  // ADR 0029 Decision 4: conditional, not unconditional, as of Step 4.
  // Set when the caller never attempted the prefetch (effortSignals
  // absent — the pre-ADR-0029 behavior, and still true for every caller
  // until Step 5 wires writer.ts's prefetch in) or genuinely couldn't
  // resolve/reach the dependency's own repo (source_available: false,
  // e.g. most PyPI dependencies — best-effort by design, ADR 0029
  // Decision 1). A dependency whose repo *did* resolve and whose
  // Releases *were* reachable correctly leaves this unset, even if zero
  // breaking-change signals were actually found — "checked, found
  // nothing" is real, higher-confidence information, not a gap.
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
