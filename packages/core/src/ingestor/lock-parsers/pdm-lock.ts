/**
 * pdm.lock parser (TOML-based, similar to poetry.lock)
 */

import { parse as parseToml, TomlError } from "smol-toml";
import type { LockFileParser, LockFileParseResult } from "../../utils/lock-parse.js";
import type { ParsedDependency } from "../../ingestor/interface.js";
import { registerLockFileParser } from "../../utils/lock-parse.js";

interface PdmLockPackage {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

interface PdmLockFile {
  package?: PdmLockPackage[];
  [key: string]: unknown;
}

const pdmLockParser: LockFileParser = {
  format: "pdm.lock",
  ecosystem: "pypi",
  fileNames: ["pdm.lock"] as const,
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
      parsed = parseToml(content);
    } catch (err) {
      const detail = err instanceof TomlError ? err.message : String(err);
      warnings.push(`Failed to parse pdm.lock as TOML: ${detail}`);
      return mergeWithManifest(manifestDeps, {
        resolvedVersions,
        transitivePackages,
        warnings,
        format: "pdm.lock" as const,
      });
    }

    if (!parsed || typeof parsed !== "object") {
      warnings.push("pdm.lock root is not an object");
      return mergeWithManifest(manifestDeps, {
        resolvedVersions,
        transitivePackages,
        warnings,
        format: "pdm.lock" as const,
      });
    }

    const lock = parsed as PdmLockFile;

    if (!lock.package || !Array.isArray(lock.package)) {
      warnings.push("pdm.lock has no [[package]] array");
      return mergeWithManifest(manifestDeps, {
        resolvedVersions,
        transitivePackages,
        warnings,
        format: "pdm.lock" as const,
      });
    }

    for (const pkg of lock.package) {
      if (!pkg.name || !pkg.version) continue;

      resolvedVersions.set(pkg.name, pkg.version);
    }

    return mergeWithManifest(manifestDeps, {
      resolvedVersions,
      transitivePackages,
      warnings,
      format: "pdm.lock" as const,
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

registerLockFileParser(pdmLockParser);
export { pdmLockParser };
