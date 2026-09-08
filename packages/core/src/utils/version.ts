/**
 * Centralized Version Parsing, Comparison, and Floor Extraction
 *
 * Consolidates logic from:
 *   - scorer/bump-inference.ts (extractVersionFloor, inferSemverBump, inferPep440Bump)
 *   - ingestor/changelog-signals.ts (parseReleaseTag, compareVersions)
 *   - ingestor/osv.ts (extractFixedVersion)
 */

import semver from "semver";
import { compare as pep440Compare, valid as pep440Valid } from "@renovatebot/pep440";
import type { Ecosystem } from "../db/schema.js";

export type VersionCompareFn = (a: string, b: string) => number;
export type VersionParseFn = (candidate: string) => string | null;

// ---------------------------------------------------------------------------
// Ecosystem-specific version parsing and comparison
// ---------------------------------------------------------------------------

/**
 * Parses a release tag into a normalized version string for the given ecosystem.
 * Returns null if the tag doesn't parse as a valid version.
 */
export function parseReleaseTag(ecosystem: Ecosystem, tag: string): string | null {
  const candidate = tag.trim().replace(/^[vV](?=\d)/, "");
  return VERSION_PARSER[ecosystem](candidate);
}

const VERSION_PARSER: Record<Ecosystem, VersionParseFn> = {
  npm: (candidate) => semver.valid(candidate),
  pypi: (candidate) => pep440Valid(candidate),
  go: (candidate) => semver.valid(candidate),
};

/**
 * Compares two version strings for the given ecosystem.
 * Returns negative if a < b, zero if equal, positive if a > b.
 */
export function compareVersions(ecosystem: Ecosystem, a: string, b: string): number {
  return VERSION_COMPARATOR[ecosystem](a, b);
}

const VERSION_COMPARATOR: Record<Ecosystem, VersionCompareFn> = {
  npm: semver.compare,
  pypi: pep440Compare,
  go: semver.compare,
};

/**
 * Extracts the fixed version from an array of OSV version ranges.
 * Returns the first "fixed" event found, or null if none.
 */
export function extractFixedVersion(
  ranges: { type: string; events: { fixed?: string }[] }[],
): string | null {
  for (const range of ranges) {
    for (const event of range.events) {
      if (event.fixed !== undefined && event.fixed !== "") {
        return event.fixed;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Version floor extraction (for semver_bump / pep440_bump inference)
// ---------------------------------------------------------------------------

/**
 * Extracts a version "floor" from a version specifier.
 * This is the minimum version that satisfies the specifier, used as the
 * lower bound for breaking-change signal scanning.
 */
export function extractVersionFloor(ecosystem: Ecosystem, versionSpec: string): string | null {
  const floorExtractor = FLOOR_EXTRACTORS[ecosystem];
  return floorExtractor(versionSpec);
}

function npmFloorExtractor(spec: string): string | null {
  // Handle ranges like "^1.2.3", "~1.2.3", ">=1.2.3", "1.2.3", "1.x", etc.
  // semver.minVersion returns the lowest version matching the range
  try {
    const min = semver.minVersion(spec, { loose: true });
    return min?.version ?? null;
  } catch {
    return null;
  }
}

function pypiFloorExtractor(spec: string): string | null {
  // PEP 440: extract lower bound from specifiers like ">=1.2.3", "~=1.2.3", "1.2.3"
  // This is a pragmatic subset - full PEP 440 parsing would need a dedicated parser
  const cleaned = spec.trim();
  if (!cleaned) return null;

  // Handle comma-separated specifiers (take the first one as primary)
  const firstSpec = cleaned.split(",")[0]?.trim() ?? "";

  // Strip operators to get the base version
  const regex = /^(?:===|==|>=|<=|>|<|~=|!=)?\s*(.+)$/;
  const match = regex.exec(firstSpec);
  const version = match?.[1]?.trim();
  if (!version) return null;
  return pep440Valid(version) ? version : null;
}

function goFloorExtractor(spec: string): string | null {
  // Go modules use semver - same as npm
  return npmFloorExtractor(spec);
}

const FLOOR_EXTRACTORS: Record<Ecosystem, (spec: string) => string | null> = {
  npm: npmFloorExtractor,
  pypi: pypiFloorExtractor,
  go: goFloorExtractor,
};

// ---------------------------------------------------------------------------
// Bump size inference (semver_bump / pep440_bump labels)
// ---------------------------------------------------------------------------

export type BumpSize = "major" | "minor" | "patch" | "unknown";

/**
 * Infers the semver bump size from current floor to target version.
 * Used for npm and Go ecosystems.
 */
export function inferSemverBump(
  currentFloor: string | null,
  targetVersion: string | null,
): BumpSize {
  if (!currentFloor || !targetVersion) return "unknown";

  const current = semver.valid(currentFloor);
  const target = semver.valid(targetVersion);

  if (!current || !target) return "unknown";

  const diff = semver.diff(current, target);
  if (!diff) return "unknown";

  // semver.diff returns: major, premajor, minor, preminor, patch, prepatch, prerelease
  if (diff.startsWith("major")) return "major";
  if (diff.startsWith("minor")) return "minor";
  if (diff.startsWith("patch")) return "patch";
  return "unknown";
}

/**
 * Infers the PEP 440 bump size from current floor to target version.
 * Used for PyPI ecosystem.
 */
export function inferPep440Bump(
  currentFloor: string | null,
  targetVersion: string | null,
): BumpSize {
  if (!currentFloor || !targetVersion) return "unknown";

  if (!pep440Valid(currentFloor) || !pep440Valid(targetVersion)) return "unknown";

  const cmp = pep440Compare(currentFloor, targetVersion);
  if (cmp >= 0) return "unknown"; // target not newer than floor

  // Heuristic: compare major/minor/micro segments
  const currentParts = parsePep440Version(currentFloor);
  const targetParts = parsePep440Version(targetVersion);

  if (!currentParts || !targetParts) return "unknown";

  if (targetParts.major > currentParts.major) return "major";
  if (targetParts.minor > currentParts.minor) return "minor";
  if (targetParts.micro > currentParts.micro) return "patch";

  return "unknown";
}

interface ParsedPep440 {
  major: number;
  minor: number;
  micro: number;
}

function parsePep440Version(version: string): ParsedPep440 | null {
  // Simplified PEP 440 parsing - handles N.N.N format
  const regex = /^(\d+)\.(\d+)\.(\d+)/;
  const match = regex.exec(version);
  if (!match) return null;
  const [, major, minor, micro] = match;
  if (!major || !minor || !micro) return null;
  return {
    major: parseInt(major, 10),
    minor: parseInt(minor, 10),
    micro: parseInt(micro, 10),
  };
}

/**
 * Unified bump inference dispatch by ecosystem.
 */
export function inferBumpSize(
  ecosystem: Ecosystem,
  currentFloor: string | null,
  targetVersion: string | null,
): BumpSize {
  switch (ecosystem) {
    case "npm":
    case "go":
      return inferSemverBump(currentFloor, targetVersion);
    case "pypi":
      return inferPep440Bump(currentFloor, targetVersion);
  }
}

// ---------------------------------------------------------------------------
// Signal key building (shared with changelog-signals.ts)
// ---------------------------------------------------------------------------

/**
 * Builds a canonical key for effort signal caching.
 * Matches changelog-signals.ts's buildSignalKey exactly.
 */
export function buildSignalKey(dependencyId: string, targetVersion: string | null): string {
  return `${dependencyId}:${targetVersion ?? "null"}`;
}
