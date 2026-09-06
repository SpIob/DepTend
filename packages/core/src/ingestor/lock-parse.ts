/**
 * Lock file parsing — shared types, merge logic, and parser registry
 *
 * Provides the common LockFileParseResult interface, the
 * mergeManifestWithLock() function used by all ecosystem parsers, and
 * a registry of lock file parsers (LOCK_PARSERS) plus a shared
 * finalizeParseResult() helper to eliminate duplication across
 * npm-parse.ts, pypi-parse.ts, and go-parse.ts.
 *
 * ADR: docs/adr/0038-lock-file-parsing.md
 */

import type { ParsedDependency, IngestorResult } from "./interface.js";
import type { Ecosystem } from "../db/schema.js";
import { parsePackageLockJson } from "./npm-lock-parse.js";
import { parseYarnLockContent } from "./yarn-lock-parse.js";
import { parseGoSumContent } from "./go-sum-parse.js";
import { parsePoetryLockContent } from "./poetry-lock-parse.js";
import { parsePipfileLockContent } from "./pipfile-lock-parse.js";
import { parsePdmLockContent } from "./pdm-lock-parse.js";

/** Result of parsing a lock file */
export interface LockFileParseResult {
  /** Map: package_name -> resolved version (for direct deps) or package_name@version_spec -> resolved version */
  resolvedVersions: Map<string, string>;
  /** Set of package names that appear ONLY in the lock file (not in manifest) */
  transitivePackages: Set<string>;
  /** Non-fatal warnings during parsing */
  warnings: string[];
  /** Which lock file format was parsed */
  format:
    | "package-lock.json"
    | "pnpm-lock.yaml"
    | "yarn.lock"
    | "poetry.lock"
    | "Pipfile.lock"
    | "pdm.lock"
    | "go.sum";
}

/** Lock file parser function type */
export type LockFileParser = (content: string) => LockFileParseResult | null;

/** Registry of lock file parsers by filename */
export const LOCK_PARSERS: Record<string, LockFileParser> = {
  "package-lock.json": parsePackageLockJson,
  "yarn.lock": parseYarnLockContent,
  "go.sum": parseGoSumContent,
  "poetry.lock": parsePoetryLockContent,
  "Pipfile.lock": parsePipfileLockContent,
  "pdm.lock": parsePdmLockContent,
  // "pnpm-lock.yaml": parsePnpmLockContent, // not yet implemented
};

/**
 * Shared finalization logic for ecosystem parsers after lock file processing.
 * Eliminates duplicated `finish()` functions in npm-parse.ts, pypi-parse.ts, go-parse.ts.
 *
 * @param dependencies - Parsed manifest dependencies
 * @param warnings - Accumulated warnings from manifest parsing
 * @param lockFilePresent - Whether a lock file was detected
 * @param lockFileContent - Raw lock file content (if available)
 * @param lockFileName - Name of the lock file (if available)
 * @param ecosystem - Target ecosystem
 * @returns Complete IngestorResult
 */
export function finalizeParseResult(
  dependencies: ParsedDependency[],
  warnings: string[],
  lockFilePresent: boolean,
  lockFileContent: string | null,
  lockFileName: string | null,
  ecosystem: Ecosystem,
): IngestorResult {
  const allWarnings = [...warnings];

  // If lock file content was provided, parse and merge it
  if (lockFileContent && lockFileName && lockFilePresent) {
    const parser = LOCK_PARSERS[lockFileName];
    if (parser) {
      const lockResult = parser(lockFileContent);
      if (lockResult) {
        return mergeManifestWithLock(dependencies, lockResult, ecosystem, allWarnings);
      }
    } else {
      allWarnings.push(
        `Lock file format ${lockFileName} not yet supported for parsing — falling back to manifest only.`,
      );
    }
  }

  if (!lockFilePresent) {
    allWarnings.push(
      "No lock file detected. Dependency versions are unresolved; confidence scores will be lower.",
    );
  }

  if (dependencies.length === 0) {
    allWarnings.push("Manifest contains no dependency entries.");
  }

  return {
    ecosystem,
    dependencies,
    lock_file_present: lockFilePresent,
    manifest_resolved: true,
    warnings: allWarnings,
  };
}

/**
 * Merge manifest dependencies with lock file data.
 *
 * Rules:
 * - Manifest deps: keep their dep_type, add resolved_version from lock file, is_transitive = false
 * - Lock-only packages: dep_type = "transitive", is_transitive = true, version_spec = "*"
 * - If a manifest dep has no match in lock file: resolved_version = null
 */
export function mergeManifestWithLock(
  manifestDeps: ParsedDependency[],
  lockResult: LockFileParseResult,
  ecosystem: Ecosystem,
  baseWarnings: string[],
): IngestorResult {
  const warnings = [...baseWarnings, ...lockResult.warnings];
  const manifestDepMap = new Map<string, ParsedDependency>();

  // Build lookup: "package_name:dep_type" -> dep (for exact match)
  // and "package_name" -> dep (for fallback match)
  for (const dep of manifestDeps) {
    manifestDepMap.set(`${dep.package_name}:${dep.dep_type}`, dep);
    if (!manifestDepMap.has(dep.package_name)) {
      manifestDepMap.set(dep.package_name, dep);
    }
  }

  const mergedDeps: ParsedDependency[] = [];

  // 1. Process manifest dependencies — enrich with lock file data
  for (const dep of manifestDeps) {
    // Try exact match first (package@version_spec), then package-only
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

  // 2. Add transitive dependencies (in lock file but not in manifest)
  for (const pkgName of lockResult.transitivePackages) {
    // Check if already in manifest (any dep_type)
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

  // Cap transitive deps to avoid explosion (configurable via env in future)
  const MAX_TRANSITIVE = 500;
  const transitiveCount = mergedDeps.filter((d) => d.is_transitive).length;
  if (transitiveCount > MAX_TRANSITIVE) {
    warnings.push(
      `Transitive dependency count (${String(transitiveCount)}) exceeds cap (${String(MAX_TRANSITIVE)}). Truncating.`,
    );
    // Keep all direct deps, truncate transitive
    const directDeps = mergedDeps.filter((d) => !d.is_transitive);
    const transitiveDeps = mergedDeps.filter((d) => d.is_transitive).slice(0, MAX_TRANSITIVE);
    mergedDeps.length = 0;
    mergedDeps.push(...directDeps, ...transitiveDeps);
  }

  return {
    ecosystem,
    dependencies: mergedDeps,
    lock_file_present: true,
    lock_file_parsed: true,
    lock_file_format: lockResult.format,
    manifest_resolved: true,
    warnings,
  };
}
