/**
 * Pipfile.lock parsing — pure, no I/O
 *
 * Parses Pipenv's lock file format (JSON).
 * Structure: { "default": {...}, "develop": {...} } with package metadata including version.
 *
 * ADR: docs/adr/0038-lock-file-parsing.md
 */

import type { LockFileParseResult } from "./lock-parse.js";

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

/**
 * Parse Pipfile.lock content.
 * Returns resolved versions for all packages and identifies transitive packages.
 * Packages under "default" are production dependencies; "develop" are dev dependencies.
 * All are treated as direct for resolution purposes; transitive detection is best-effort.
 */
export function parsePipfileLockContent(content: string): LockFileParseResult {
  const warnings: string[] = [];
  const resolvedVersions = new Map<string, string>();
  const transitivePackages = new Set<string>();

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    warnings.push(`Failed to parse Pipfile.lock as JSON: ${String(err)}`);
    return { resolvedVersions, transitivePackages, warnings, format: "Pipfile.lock" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push("Pipfile.lock root is not an object");
    return { resolvedVersions, transitivePackages, warnings, format: "Pipfile.lock" };
  }

  const lock = parsed as PipfileLockFile;

  const allPackages = new Map<string, PipfileLockPackage>();

  for (const section of ["default", "develop"] as const) {
    const sectionData = lock[section];
    if (sectionData && typeof sectionData === "object") {
      for (const [name, pkg] of Object.entries(sectionData)) {
        if (typeof pkg === "object" && typeof pkg.version === "string") {
          allPackages.set(name, pkg);
          resolvedVersions.set(name, pkg.version);
        }
      }
    }
  }

  return { resolvedVersions, transitivePackages, warnings, format: "Pipfile.lock" };
}
