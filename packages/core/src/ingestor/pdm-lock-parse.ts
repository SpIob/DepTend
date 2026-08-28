/**
 * pdm.lock parsing — pure, no I/O
 *
 * Parses PDM's lock file format (TOML-based, similar to poetry.lock but different structure).
 * Structure: [[package]] array with name, version, dependencies, etc.
 *
 * ADR: docs/adr/0038-lock-file-parsing.md
 */

import { parse as parseToml, TomlError } from "smol-toml";
import type { LockFileParseResult } from "./lock-parse.js";

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

/**
 * Parse pdm.lock content.
 * Returns resolved versions for all packages.
 * Transitive package detection is not reliable from pdm.lock alone
 * (requires the manifest), so transitivePackages is left empty.
 * The merge logic in lock-parse.ts will handle transitive detection
 * by comparing against the manifest dependencies.
 */
export function parsePdmLockContent(content: string): LockFileParseResult {
  const warnings: string[] = [];
  const resolvedVersions = new Map<string, string>();
  const transitivePackages = new Set<string>();

  let parsed: unknown;
  try {
    parsed = parseToml(content);
  } catch (err) {
    const detail = err instanceof TomlError ? err.message : String(err);
    warnings.push(`Failed to parse pdm.lock as TOML: ${detail}`);
    return { resolvedVersions, transitivePackages, warnings, format: "pdm.lock" };
  }

  if (!parsed || typeof parsed !== "object") {
    warnings.push("pdm.lock root is not an object");
    return { resolvedVersions, transitivePackages, warnings, format: "pdm.lock" };
  }

  const lock = parsed as PdmLockFile;

  if (!lock.package || !Array.isArray(lock.package)) {
    warnings.push("pdm.lock has no [[package]] array");
    return { resolvedVersions, transitivePackages, warnings, format: "pdm.lock" };
  }

  for (const pkg of lock.package) {
    if (!pkg.name || !pkg.version) continue;

    resolvedVersions.set(pkg.name, pkg.version);
  }

  return { resolvedVersions, transitivePackages, warnings, format: "pdm.lock" };
}
