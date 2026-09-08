/**
 * Pipfile.lock parser (JSON)
 */

import type { LockFileParser, LockFileParseResult } from "../../utils/lock-parse.js";
import type { ParsedDependency } from "../../ingestor/interface.js";
import { registerLockFileParser } from "../../utils/lock-parse.js";

interface PipfileLockPackage {
  version: string;
  hashes?: string[];
  markers?: string;
  index?: string;
  [key: string]: unknown;
}

interface PipfileLockFile {
  default?: Record<string, PipfileLockPackage>;
  develop?: Record<string, PipfileLockPackage>;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

const pipfileLockParser: LockFileParser = {
  format: "Pipfile.lock",
  ecosystem: "pypi",
  fileNames: ["Pipfile.lock"] as const,
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
      warnings.push(`Failed to parse Pipfile.lock as JSON: ${String(err)}`);
      return mergeWithManifest(manifestDeps, {
        resolvedVersions,
        transitivePackages,
        warnings,
        format: "Pipfile.lock" as const,
      });
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push("Pipfile.lock root is not an object");
      return mergeWithManifest(manifestDeps, {
        resolvedVersions,
        transitivePackages,
        warnings,
        format: "Pipfile.lock" as const,
      });
    }

    const lock = parsed as PipfileLockFile;

    for (const section of ["default", "develop"] as const) {
      const sectionData = lock[section];
      if (sectionData && typeof sectionData === "object") {
        for (const [name, pkg] of Object.entries(sectionData)) {
          if (typeof pkg === "object" && typeof pkg.version === "string") {
            resolvedVersions.set(name, pkg.version);
          }
        }
      }
    }

    return mergeWithManifest(manifestDeps, {
      resolvedVersions,
      transitivePackages,
      warnings,
      format: "Pipfile.lock" as const,
    });
  },
};

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

registerLockFileParser(pipfileLockParser);
export { pipfileLockParser };
