/**
 * poetry.lock parsing — pure, no I/O
 *
 * Parses Poetry's lock file format (TOML-based).
 * Structure: [[package]] array with name, version, description, optional, python-versions, etc.
 * Dependencies are nested under each package's "dependencies" table.
 *
 * ADR: docs/adr/0038-lock-file-parsing.md
 */

import { parse as parseToml, TomlError } from "smol-toml";
import type { LockFileParseResult } from "./lock-parse.js";

interface PoetryLockPackage {
  name: string;
  version: string;
  description?: string;
  optional?: boolean;
  "python-versions"?: string;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

interface PoetryLockFile {
  package?: PoetryLockPackage[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Parse poetry.lock content.
 * Returns resolved versions for all packages (direct + transitive) and
 * identifies which packages are direct dependencies of the root project.
 */
export function parsePoetryLockContent(content: string): LockFileParseResult {
  const warnings: string[] = [];
  const resolvedVersions = new Map<string, string>();
  const transitivePackages = new Set<string>();

  let parsed: unknown;
  try {
    parsed = parseToml(content);
  } catch (err) {
    const detail = err instanceof TomlError ? err.message : String(err);
    warnings.push(`Failed to parse poetry.lock as TOML: ${detail}`);
    return { resolvedVersions, transitivePackages, warnings, format: "poetry.lock" };
  }

  if (!parsed || typeof parsed !== "object") {
    warnings.push("poetry.lock root is not an object");
    return { resolvedVersions, transitivePackages, warnings, format: "poetry.lock" };
  }

  const lock = parsed as PoetryLockFile;

  if (!lock.package || !Array.isArray(lock.package)) {
    warnings.push("poetry.lock has no [[package]] array");
    return { resolvedVersions, transitivePackages, warnings, format: "poetry.lock" };
  }

  const rootPackageNames = new Set<string>();

  if (typeof lock.metadata === "object") {
    const meta = lock.metadata;
    if (meta.content_hash) {
      // root package names are in metadata.content_hash in some versions
      // but the authoritative list is packages with optional: false at root level
    }
    if (Array.isArray(meta.files)) {
      // ignore
    }
  }

  for (const pkg of lock.package) {
    if (!pkg.name || !pkg.version) continue;

    resolvedVersions.set(pkg.name, pkg.version);

    if (pkg.optional === false) {
      rootPackageNames.add(pkg.name);
    }
  }

  for (const pkg of lock.package) {
    if (!pkg.name) continue;

    if (!rootPackageNames.has(pkg.name)) {
      transitivePackages.add(pkg.name);
    }

    if (pkg.dependencies && typeof pkg.dependencies === "object") {
      for (const depName of Object.keys(pkg.dependencies)) {
        if (!rootPackageNames.has(depName)) {
          transitivePackages.add(depName);
        }
      }
    }
  }

  return { resolvedVersions, transitivePackages, warnings, format: "poetry.lock" };
}
