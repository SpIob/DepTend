/**
 * Mission type detection
 *
 * Classifies dependency issues into mission types based on available data.
 * This runs before scoring to determine which type of mission to create.
 *
 * Types (from mission_type enum in schema.ts):
 * - vulnerability_fix: has advisory match (existing behavior)
 * - dep_update: outdated dependency without advisory
 * - maintenance: deprecated, archived, or unmaintained upstream
 * - license_issue: license incompatibility (requires license detection)
 */

import type { Dependency, Advisory, MissionType } from "../db/schema.js";
import semver from "semver";
import { compare as pep440Compare, validRange as pep440ValidRange } from "@renovatebot/pep440";
import { extractPep440Floor } from "./mission-scorer.js";

export type { MissionType };

export interface MissionTypeClassification {
  type: MissionType;
  /** The advisory driving this mission, if vulnerability_fix */
  advisory?: Advisory | undefined;
  /** The target version for dep_update/maintenance */
  targetVersion?: string | undefined;
  /** Reason for maintenance classification */
  maintenanceReason?: "deprecated" | "archived" | "unmaintained" | undefined;
  /** License details for license_issue */
  licenseInfo?: { current: string; issue: string } | undefined;
}

/**
 * Classifies a dependency into a mission type based on available signals.
 * Priority order:
 * 1. vulnerability_fix: has matching advisory
 * 2. license_issue: license incompatibility detected (not yet implemented)
 * 3. maintenance: deprecated/archived/unmaintained
 * 4. dep_update: outdated but no advisory
 * 5. none: no actionable issue
 */
export function classifyMissionType(
  dependency: Dependency,
  advisories: Advisory[],
  registryDeprecated?: boolean,
  registryArchived?: boolean,
): MissionTypeClassification | null {
  // 1. Vulnerability fix - has matching advisory
  if (advisories.length > 0) {
    const advisory = advisories[0];
    if (!advisory) return null;
    return {
      type: "vulnerability_fix",
      advisory,
      targetVersion: advisory.fixedVersion ?? dependency.latestVersion ?? undefined,
    };
  }

  // 2. License issue - not yet implemented, would need license detection
  // Placeholder for future implementation

  // 3. Maintenance - deprecated, archived, or unmaintained
  if (dependency.isDeprecated || registryDeprecated || registryArchived) {
    return {
      type: "maintenance",
      targetVersion: dependency.latestVersion ?? undefined,
      maintenanceReason: registryArchived
        ? "archived"
        : dependency.isDeprecated || registryDeprecated
          ? "deprecated"
          : "unmaintained",
    };
  }

  // 4. Dependency update - outdated but no advisory
  if (dependency.latestVersion && dependency.resolvedVersion) {
    // Check if current version is behind latest
    if (
      isVersionBehind(dependency.resolvedVersion, dependency.latestVersion, dependency.ecosystem)
    ) {
      return {
        type: "dep_update",
        targetVersion: dependency.latestVersion,
      };
    }
  } else if (dependency.latestVersion && !dependency.resolvedVersion) {
    // No resolved version - use version spec floor as proxy
    const floor = extractVersionFloorForType(dependency.ecosystem, dependency.versionSpec);
    if (floor && isVersionBehind(floor, dependency.latestVersion, dependency.ecosystem)) {
      return {
        type: "dep_update",
        targetVersion: dependency.latestVersion,
      };
    }
  }

  // No actionable issue
  return null;
}

function isVersionBehind(current: string, target: string, ecosystem: string): boolean {
  try {
    if (ecosystem === "npm" || ecosystem === "go") {
      const currentCoerced = semver.coerce(current);
      const targetCoerced = semver.coerce(target);
      if (!currentCoerced || !targetCoerced) return false;
      return semver.compare(currentCoerced.version, targetCoerced.version) < 0;
    } else if (ecosystem === "pypi") {
      // pep440Compare expects raw version strings, not parsed objects
      return pep440Compare(current, target) < 0;
    }
  } catch {
    // If comparison fails, assume not behind
  }
  return false;
}

function extractVersionFloorForType(ecosystem: string, versionSpec: string): string | null {
  try {
    if (ecosystem === "npm" || ecosystem === "go") {
      const normalizedRange = semver.validRange(versionSpec);
      if (!normalizedRange || normalizedRange === "*") return null;
      const currentProxy = semver.minVersion(versionSpec);
      return currentProxy === null ? null : currentProxy.version;
    } else if (ecosystem === "pypi") {
      if (!pep440ValidRange(versionSpec)) return null;
      return extractPep440Floor(versionSpec);
    }
  } catch {
    // Ignore
  }
  return null;
}

/**
 * Gets all mission classifications for a repo's dependencies.
 * Returns a flat list of (dependencyId, classification) pairs.
 * For vulnerability_fix, one entry per advisory; for other types, one per dependency.
 */
export function classifyAllMissions(
  dependencies: Dependency[],
  advisoryMap: Map<string, Advisory[]>,
  registryMetadata?: Map<string, { isDeprecated?: boolean; isArchived?: boolean }>,
): { dependencyId: string; classification: MissionTypeClassification }[] {
  const result: { dependencyId: string; classification: MissionTypeClassification }[] = [];

  for (const dep of dependencies) {
    const advisories = advisoryMap.get(dep.packageName) ?? [];
    const meta = registryMetadata?.get(dep.packageName) ?? {};

    if (advisories.length > 0) {
      // vulnerability_fix: one mission per advisory
      for (const advisory of advisories) {
        const classification = classifyMissionType(
          dep,
          [advisory],
          meta.isDeprecated,
          meta.isArchived,
        );
        if (classification) {
          result.push({ dependencyId: dep.id, classification });
        }
      }
    } else {
      // dep_update, maintenance, license_issue: one mission per dependency
      const classification = classifyMissionType(dep, [], meta.isDeprecated, meta.isArchived);
      if (classification) {
        result.push({ dependencyId: dep.id, classification });
      }
    }
  }

  return result;
}
