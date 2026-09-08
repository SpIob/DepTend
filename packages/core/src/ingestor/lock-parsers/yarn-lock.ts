/**
 * yarn.lock parser (Yarn v1 Classic and v2+ Berry)
 */

import { parse as parseYarnLock } from "@yarnpkg/lockfile";
import type { LockFileParser, LockFileParseResult } from "../../utils/lock-parse.js";
import type { ParsedDependency } from "../../ingestor/interface.js";
import { registerLockFileParser } from "../../utils/lock-parse.js";

const yarnLockParser: LockFileParser = {
  format: "yarn.lock",
  ecosystem: "npm",
  fileNames: ["yarn.lock"] as const,
  supported: true,

  parse(
    manifestDeps: ParsedDependency[],
    content: string,
  ): { dependencies: ParsedDependency[]; lockFileParsed: boolean; warnings: string[] } {
    const warnings: string[] = [];
    const resolvedVersions = new Map<string, string>();
    const transitivePackages = new Set<string>();

    let parsed: ReturnType<typeof parseYarnLock>;
    try {
      parsed = parseYarnLock(content);
    } catch (err) {
      warnings.push(`Failed to parse yarn.lock: ${String(err)}`);
      return mergeWithManifest(manifestDeps, {
        resolvedVersions,
        transitivePackages,
        warnings,
        format: "yarn.lock" as const,
      });
    }

    const parsedObj = parsed as { object?: Record<string, unknown> };
    if (!parsedObj.object) {
      warnings.push("yarn.lock parsed to unexpected format");
      return mergeWithManifest(manifestDeps, {
        resolvedVersions,
        transitivePackages,
        warnings,
        format: "yarn.lock" as const,
      });
    }

    const lockObject = parsedObj.object;

    const allEntries = new Map<
      string,
      { version: string; dependencies?: Record<string, string> | undefined }
    >();

    for (const [key, entry] of Object.entries(lockObject)) {
      if (entry && typeof entry === "object" && "version" in entry) {
        const version = (entry as Record<string, unknown>).version;
        if (typeof version === "string") {
          allEntries.set(key, {
            version,
            dependencies: (entry as Record<string, unknown>).dependencies as
              Record<string, string> | undefined,
          });
        }
      }
    }

    const referencedByOthers = new Set<string>();

    for (const [, entry] of allEntries) {
      if (entry.dependencies) {
        for (const depName of Object.keys(entry.dependencies)) {
          for (const [key] of allEntries) {
            if (key.startsWith(`${depName}@`)) {
              referencedByOthers.add(key);
            }
          }
        }
      }
    }

    for (const [key, entry] of allEntries) {
      const isDirect = !referencedByOthers.has(key);

      const atIndex = key.lastIndexOf("@");
      const pkgName = atIndex > 0 ? key.slice(0, atIndex) : key;
      const versionSpec = atIndex > 0 ? key.slice(atIndex + 1) : "*";

      if (isDirect) {
        resolvedVersions.set(`${pkgName}@${versionSpec}`, entry.version);
        resolvedVersions.set(pkgName, entry.version);
      } else {
        transitivePackages.add(pkgName);
        resolvedVersions.set(pkgName, entry.version);
      }

      if (entry.dependencies) {
        for (const [depName, depSpec] of Object.entries(entry.dependencies)) {
          if (
            !referencedByOthers.has(`${depName}@${depSpec}`) &&
            !referencedByOthers.has(depName)
          ) {
            transitivePackages.add(depName);
          }
          const depEntry = allEntries.get(`${depName}@${depSpec}`) ?? allEntries.get(depName);
          if (depEntry) {
            resolvedVersions.set(depName, depEntry.version);
          }
        }
      }
    }

    for (const pkgName of transitivePackages) {
      if (!resolvedVersions.has(pkgName)) {
        for (const [key, entry] of allEntries) {
          if (key.startsWith(`${pkgName}@`)) {
            resolvedVersions.set(pkgName, entry.version);
            break;
          }
        }
      }
    }

    return mergeWithManifest(manifestDeps, {
      resolvedVersions,
      transitivePackages,
      warnings,
      format: "yarn.lock" as const,
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

registerLockFileParser(yarnLockParser);
export { yarnLockParser };
