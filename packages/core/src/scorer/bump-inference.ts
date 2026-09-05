/**
 * Version bump inference — semver (npm, Go) and PEP 440 (PyPI)
 *
 * Pure functions extracting a "current version" proxy from a declared range
 * and estimating the bump size to a target version. Lock-file-resolved
 * versions (ADR 0038) are passed as `currentVersion` to bypass the estimate.
 *
 * ADR: docs/adr/0007-mission-score-writing.md (§4),
 *      docs/adr/0022-pypi-pep440-scoring.md (Decision 3),
 *      docs/adr/0024-go-ecosystem.md (Decision 3),
 *      docs/adr/0029-breaking-change-signals.md (Step 5 — extractVersionFloor),
 *      docs/adr/0038-lock-file-resolution.md
 */

import semver from "semver";
import {
  compare as pep440Compare,
  explain as pep440Explain,
  valid as pep440Valid,
  validRange as pep440ValidRange,
} from "@renovatebot/pep440";
import type { Ecosystem } from "../db/schema.js";
import type { EffortInputs } from "../db/json-types.js";

type SemverBump = EffortInputs["semver_bump"];

// ---------------------------------------------------------------------------
// semver floor extraction (npm, Go)
// ---------------------------------------------------------------------------

/**
 * Extracts a "current version" proxy from a declared semver range — the
 * same floor inferSemverBump() uses for its own bump-size estimate.
 * Split out so extractVersionFloor() can reuse it without duplicating logic.
 */
export function extractSemverFloor(versionSpec: string): string | null {
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
 * When the dependency's lock file was parsed (ADR 0038), the "current" side
 * is the resolved version actually installed. Otherwise it falls back to the
 * minimum version satisfying the declared range — an estimate, not a
 * confirmed fact. The `no_lock_file` confidence flag distinguishes the two.
 *
 * If currentVersion is provided (e.g., from a lock file), it is used as the
 * "current" version instead of computing the floor from the version spec.
 * This is the key improvement from ADR 0038.
 */
export function inferSemverBump(
  versionSpec: string,
  targetVersion: string | null,
  currentVersion?: string | null,
): SemverBump {
  if (targetVersion === null) {
    return "unknown";
  }

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
// PEP 440 floor extraction & bump inference (PyPI)
// ---------------------------------------------------------------------------

const PEP440_FLOOR_OPERATORS = new Set(["==", ">=", "~=", ">", "==="]);
const PEP440_CLAUSE_RE = /^(===|~=|==|!=|<=|>=|<|>)\s*(.+)$/;

function releaseTriple(release: number[]): [number, number, number] {
  return [release[0] ?? 0, release[1] ?? 0, release[2] ?? 0];
}

/**
 * Extracts a "current version" proxy from a PEP 440 specifier — the PyPI
 * equivalent of semver.minVersion() above, but hand-rolled rather than
 * pulled from @renovatebot/pep440 itself: the library's own specifier.parse
 * carries an explicit "have doubts regarding this" comment and isn't
 * re-exported. This only needs comma-splitting plus a single-operator regex.
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

    const version = pep440Valid(rawVersion.trim());
    if (version === null) continue;

    if (floor === null || pep440Compare(version, floor) > 0) {
      floor = version;
    }
  }

  return floor;
}

/**
 * PEP 440 equivalent of inferSemverBump — same shape: when a lock
 * file was parsed (ADR 0038), `currentVersion` is the resolved version
 * actually installed; otherwise the floor of the declared range is used
 * as an estimate and the `no_lock_file` confidence flag distinguishes
 * the two.
 */
export function inferPep440Bump(
  versionSpec: string,
  targetVersion: string | null,
  currentVersion?: string | null,
): SemverBump {
  if (targetVersion === null) {
    return "unknown";
  }

  if (currentVersion !== undefined && currentVersion !== null) {
    const floor = pep440Explain(currentVersion);
    const target = pep440Explain(targetVersion);
    if (floor === null || target === null) {
      return "unknown";
    }

    if (floor.epoch !== target.epoch) {
      return "major";
    }

    const [floorMajor, floorMinor, floorPatch] = releaseTriple(floor.release);
    const [targetMajor, targetMinor, targetPatch] = releaseTriple(target.release);

    if (floorMajor !== targetMajor) return "major";
    if (floorMinor !== targetMinor) return "minor";
    if (floorPatch !== targetPatch) return "patch";

    return "patch";
  }

  if (!pep440ValidRange(versionSpec)) {
    return "unknown";
  }

  const floorRaw = extractPep440Floor(versionSpec);
  if (floorRaw === null) {
    return "unknown";
  }

  const floor = pep440Explain(floorRaw);
  const target = pep440Explain(targetVersion);
  if (floor === null || target === null) {
    return "unknown";
  }

  if (floor.epoch !== target.epoch) {
    return "major";
  }

  const [floorMajor, floorMinor, floorPatch] = releaseTriple(floor.release);
  const [targetMajor, targetMinor, targetPatch] = releaseTriple(target.release);

  if (floorMajor !== targetMajor) return "major";
  if (floorMinor !== targetMinor) return "minor";
  if (floorPatch !== targetPatch) return "patch";

  return "patch";
}

// ---------------------------------------------------------------------------
// Ecosystem dispatch
// ---------------------------------------------------------------------------

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
 * one.
 */
export function extractVersionFloor(ecosystem: Ecosystem, versionSpec: string): string | null {
  return FLOOR_EXTRACTION_BY_ECOSYSTEM[ecosystem](versionSpec);
}

export function inferBumpForEcosystem(
  ecosystem: Ecosystem,
  versionSpec: string,
  targetVersion: string | null,
  currentVersion?: string | null,
): SemverBump {
  if (ecosystem === "npm" || ecosystem === "go") {
    return inferSemverBump(versionSpec, targetVersion, currentVersion);
  }
  if (ecosystem === "pypi") {
    return inferPep440Bump(versionSpec, targetVersion, currentVersion);
  }
  return "unknown";
}
