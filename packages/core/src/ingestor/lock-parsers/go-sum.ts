/**
 * go.sum parser
 */

import type { LockFileParser, LockFileParseResult } from "../../utils/lock-parse.js";
import type { ParsedDependency } from "../../ingestor/interface.js";
import { registerLockFileParser } from "../../utils/lock-parse.js";

const goSumParser: LockFileParser = {
  format: "go.sum",
  ecosystem: "go",
  fileNames: ["go.sum"] as const,
  supported: true,

  parse(
    manifestDeps: ParsedDependency[],
    content: string,
  ): { dependencies: ParsedDependency[]; lockFileParsed: boolean; warnings: string[] } {
    const warnings: string[] = [];
    const resolvedVersions = new Map<string, string>();
    const transitivePackages = new Set<string>();

    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;

      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) {
        warnings.push(`Skipping malformed go.sum line: "${trimmed}"`);
        continue;
      }

      const [modulePath, version] = parts;

      if (!modulePath || !version) {
        warnings.push(`Skipping malformed go.sum line: "${trimmed}"`);
        continue;
      }

      if (!resolvedVersions.has(modulePath)) {
        resolvedVersions.set(modulePath, version);
      }
    }

    return mergeWithManifest(manifestDeps, {
      resolvedVersions,
      transitivePackages,
      warnings,
      format: "go.sum" as const,
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

registerLockFileParser(goSumParser);
export { goSumParser };
