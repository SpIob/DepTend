/**
 * package-lock.json parser (npm v7+ format, with v1/v2 fallback)
 */

import type { LockFileParser, LockFileParseResult } from "../../utils/lock-parse.js";
import type { ParsedDependency } from "../../ingestor/interface.js";
import { registerLockFileParser } from "../../utils/lock-parse.js";

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

const packageLockParser: LockFileParser = {
  format: "package-lock.json",
  ecosystem: "npm",
  fileNames: ["package-lock.json"] as const,
  supported: true,

  parse(
    manifestDeps: ParsedDependency[],
    content: string,
  ): { dependencies: ParsedDependency[]; lockFileParsed: boolean; warnings: string[] } {
    const warnings: string[] = [];
    const resolvedVersions = new Map<string, string>();
    const transitivePackages = new Set<string>();

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      warnings.push(`Failed to parse package-lock.json as JSON: ${String(err)}`);
      return mergeWithManifest(manifestDeps, {
        resolvedVersions,
        transitivePackages,
        warnings,
        format: "package-lock.json" as const,
      });
    }

    if (!parsed || typeof parsed !== "object") {
      warnings.push("package-lock.json root is not an object");
      return mergeWithManifest(manifestDeps, {
        resolvedVersions,
        transitivePackages,
        warnings,
        format: "package-lock.json" as const,
      });
    }

    const lock = parsed as Record<string, unknown>;
    const lockfileVersion = typeof lock.lockfileVersion === "number" ? lock.lockfileVersion : 1;

    if (lockfileVersion >= 3 && lock.packages && typeof lock.packages === "object") {
      parsePackagesFormat(
        lock.packages as Record<string, PackageLockEntry>,
        resolvedVersions,
        transitivePackages,
        warnings,
      );
    } else if (lockfileVersion >= 1 && lock.dependencies && typeof lock.dependencies === "object") {
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

    return mergeWithManifest(manifestDeps, {
      resolvedVersions,
      transitivePackages,
      warnings,
      format: "package-lock.json" as const,
    });
  },
};

function parsePackagesFormat(
  packages: Record<string, PackageLockEntry>,
  resolvedVersions: Map<string, string>,
  transitivePackages: Set<string>,
  warnings: string[],
): void {
  const root = packages[""];
  if (!root) {
    warnings.push("package-lock.json: no root package ('') found");
    return;
  }

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

  for (const [pkgName, { versionSpec }] of rootDeps) {
    const pkgEntry = packages[`node_modules/${pkgName}`];
    if (pkgEntry?.version) {
      resolvedVersions.set(`${pkgName}@${versionSpec}`, pkgEntry.version);
      resolvedVersions.set(pkgName, pkgEntry.version);
    } else {
      warnings.push(`package-lock.json: no version found for root dependency ${pkgName}`);
    }

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
  for (const [pkgName, entry] of Object.entries(dependencies)) {
    if (entry.version) {
      resolvedVersions.set(pkgName, entry.version);
    }

    const transitive = entry.requires ?? entry.dependencies;
    if (transitive) {
      for (const transitiveName of Object.keys(transitive)) {
        transitivePackages.add(transitiveName);
        const transitiveEntry = dependencies[transitiveName];
        if (transitiveEntry?.version) {
          resolvedVersions.set(transitiveName, transitiveEntry.version);
        }
      }
    }
  }
}

function mergeWithManifest(
  manifestDeps: ParsedDependency[],
  lockResult: LockFileParseResult,
): { dependencies: ParsedDependency[]; lockFileParsed: boolean; warnings: string[] } {
  const warnings = [...lockResult.warnings];
  const manifestDepMap = new Map<string, ParsedDependency>();

  for (const dep of manifestDeps) {
    manifestDepMap.set(`${dep.package_name}:${dep.dep_type}`, dep);
    if (!manifestDepMap.has(dep.package_name)) {
      manifestDepMap.set(dep.package_name, dep);
    }
  }

  const mergedDeps: ParsedDependency[] = [];

  for (const dep of manifestDeps) {
    const exactKey = `${dep.package_name}@${dep.version_spec}`;
    const resolved =
      lockResult.resolvedVersions.get(exactKey) ??
      lockResult.resolvedVersions.get(dep.package_name) ??
      null;

    mergedDeps.push({
      ...dep,
      resolved_version: resolved,
      is_transitive: false,
    });
  }

  for (const pkgName of lockResult.transitivePackages) {
    const inManifest = manifestDeps.some((d) => d.package_name === pkgName);
    if (!inManifest) {
      const resolved = lockResult.resolvedVersions.get(pkgName) ?? null;
      mergedDeps.push({
        package_name: pkgName,
        version_spec: "*",
        dep_type: "transitive",
        resolved_version: resolved,
        is_transitive: true,
      });
    }
  }

  const MAX_TRANSITIVE = 500;
  const transitiveCount = mergedDeps.filter((d) => d.is_transitive).length;
  if (transitiveCount > MAX_TRANSITIVE) {
    warnings.push(
      `Transitive dependency count (${String(transitiveCount)}) exceeds cap (${String(MAX_TRANSITIVE)}). Truncating.`,
    );
    const directDeps = mergedDeps.filter((d) => !d.is_transitive);
    const transitiveDeps = mergedDeps.filter((d) => d.is_transitive).slice(0, MAX_TRANSITIVE);
    mergedDeps.length = 0;
    mergedDeps.push(...directDeps, ...transitiveDeps);
  }

  return { dependencies: mergedDeps, lockFileParsed: true, warnings };
}

registerLockFileParser(packageLockParser);
export { packageLockParser };
