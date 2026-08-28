/**
 * package-lock.json parsing — pure, no I/O
 *
 * Parses npm v7+ lock file format (the "packages" map format).
 * Also handles older v1/v2 formats for backward compatibility.
 *
 * Format reference:
 * - npm v7+: { "packages": { "": { "dependencies": {...} }, "node_modules/pkg": { "version": "1.2.3", "dependencies": {...} } } }
 * - npm v1/v2: { "dependencies": { "pkg": { "version": "1.2.3", "requires": {...} } } }
 *
 * ADR: docs/adr/0038-lock-file-parsing.md
 */

import type { LockFileParseResult } from "./lock-parse.js";

interface PackageLockEntry {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  dev?: boolean;
  optional?: boolean;
  [key: string]: unknown;
}

interface PackageLockV1Dep {
  version: string;
  requires?: Record<string, string>;
  dependencies?: Record<string, string>;
  dev?: boolean;
  optional?: boolean;
}

/**
 * Parse package-lock.json content (npm v7+ format preferred, v1/v2 supported).
 * Returns resolved versions for direct dependencies and transitive dependency names.
 */
export function parsePackageLockJson(content: string): LockFileParseResult {
  const warnings: string[] = [];
  const resolvedVersions = new Map<string, string>();
  const transitivePackages = new Set<string>();

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    warnings.push(`Failed to parse package-lock.json as JSON: ${String(err)}`);
    return { resolvedVersions, transitivePackages, warnings, format: "package-lock.json" };
  }

  if (!parsed || typeof parsed !== "object") {
    warnings.push("package-lock.json root is not an object");
    return { resolvedVersions, transitivePackages, warnings, format: "package-lock.json" };
  }

  const lock = parsed as Record<string, unknown>;

  // Detect format by lockfileVersion and structure
  const lockfileVersion = typeof lock.lockfileVersion === "number" ? lock.lockfileVersion : 1;

  if (lockfileVersion >= 3 && lock.packages && typeof lock.packages === "object") {
    // npm v7+ format (lockfileVersion 3+)
    parsePackagesFormat(
      lock.packages as Record<string, PackageLockEntry>,
      resolvedVersions,
      transitivePackages,
      warnings,
    );
  } else if (lockfileVersion >= 1 && lock.dependencies && typeof lock.dependencies === "object") {
    // npm v1/v2 format
    parseV1Format(
      lock.dependencies as Record<string, PackageLockV1Dep>,
      resolvedVersions,
      transitivePackages,
      warnings,
    );
  } else {
    warnings.push(
      `Unrecognized package-lock.json format (lockfileVersion: ${String(lockfileVersion)})`,
    );
  }

  return { resolvedVersions, transitivePackages, warnings, format: "package-lock.json" };
}

function parsePackagesFormat(
  packages: Record<string, PackageLockEntry>,
  resolvedVersions: Map<string, string>,
  transitivePackages: Set<string>,
  warnings: string[],
): void {
  // The root package is at key "" (empty string)
  // Dependencies are at "node_modules/pkg-name"
  // We need to walk the tree from the root's dependencies

  const root = packages[""];
  if (!root) {
    warnings.push("package-lock.json: no root package ('') found");
    return;
  }

  // Collect all package names from the root's dependencies (all types)
  const rootDeps = new Map<string, { versionSpec: string; depType: string }>();

  const addDeps = (deps: Record<string, string> | undefined, depType: string): void => {
    if (!deps) return;
    for (const [name, versionSpec] of Object.entries(deps)) {
      rootDeps.set(name, { versionSpec, depType });
    }
  };

  addDeps(root.dependencies, "production");
  addDeps(root.devDependencies, "development");
  addDeps(root.optionalDependencies, "optional");
  addDeps(root.peerDependencies, "peer");

  // For each root dependency, find its entry in packages and get its version
  for (const [pkgName, { versionSpec }] of rootDeps) {
    // The package entry is at "node_modules/pkg-name"
    const pkgEntry = packages[`node_modules/${pkgName}`];
    if (pkgEntry?.version) {
      // Store with both exact key (name@spec) and name-only for matching
      resolvedVersions.set(`${pkgName}@${versionSpec}`, pkgEntry.version);
      resolvedVersions.set(pkgName, pkgEntry.version);
    } else {
      warnings.push(`package-lock.json: no version found for root dependency ${pkgName}`);
    }

    // Also collect transitive deps from this package's dependencies
    if (pkgEntry?.dependencies) {
      for (const [transitiveName, transitiveSpec] of Object.entries(pkgEntry.dependencies)) {
        if (!rootDeps.has(transitiveName)) {
          transitivePackages.add(transitiveName);
        }
        const transitiveEntry = packages[`node_modules/${transitiveName}`];
        if (transitiveEntry?.version) {
          resolvedVersions.set(`${transitiveName}@${transitiveSpec}`, transitiveEntry.version);
          resolvedVersions.set(transitiveName, transitiveEntry.version);
        }
      }
    }
  }

  // Also scan ALL packages in the lock file for any we might have missed
  // (handles edge cases where root deps don't list everything)
  for (const [key, entry] of Object.entries(packages)) {
    if (key === "" || !key.startsWith("node_modules/")) continue;
    const pkgName = key.slice("node_modules/".length);
    if (entry.version && !resolvedVersions.has(pkgName)) {
      resolvedVersions.set(pkgName, entry.version);
    }
  }
}

function parseV1Format(
  dependencies: Record<string, PackageLockV1Dep>,
  resolvedVersions: Map<string, string>,
  transitivePackages: Set<string>,
  _warnings: string[],
): void {
  // v1/v2 format: dependencies at root level
  for (const [pkgName, entry] of Object.entries(dependencies)) {
    if (entry.version) {
      resolvedVersions.set(pkgName, entry.version);
    }

    // Requires/dependencies are transitive
    const transitive = entry.requires ?? entry.dependencies;
    if (transitive) {
      for (const transitiveName of Object.keys(transitive)) {
        transitivePackages.add(transitiveName);
        // Try to find the transitive dep's version in the same lock file
        const transitiveEntry = dependencies[transitiveName];
        if (transitiveEntry?.version) {
          resolvedVersions.set(transitiveName, transitiveEntry.version);
        }
      }
    }
  }
}
