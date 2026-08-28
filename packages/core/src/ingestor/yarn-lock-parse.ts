/**
 * yarn.lock parsing — pure, no I/O
 *
 * Parses both Yarn v1 (Classic) and Yarn v2+ (Berry) lock files.
 * Uses @yarnpkg/lockfile which handles both formats.
 *
 * ADR: docs/adr/0038-lock-file-parsing.md
 */

import { parse as parseYarnLock } from "@yarnpkg/lockfile";
import type { LockFileParseResult } from "./lock-parse.js";

/**
 * Parse yarn.lock content (Yarn v1 Classic or v2+ Berry).
 * Returns resolved versions for direct dependencies and transitive dependency names.
 */
export function parseYarnLockContent(content: string): LockFileParseResult {
  const warnings: string[] = [];
  const resolvedVersions = new Map<string, string>();
  const transitivePackages = new Set<string>();

  let parsed: ReturnType<typeof parseYarnLock>;
  try {
    parsed = parseYarnLock(content);
  } catch (err) {
    warnings.push(`Failed to parse yarn.lock: ${String(err)}`);
    return { resolvedVersions, transitivePackages, warnings, format: "yarn.lock" };
  }

  // parseYarnLock always returns an object with 'object' and 'warnings' properties
  // but 'object' may be undefined if parsing failed
  const parsedObj = parsed as { object?: Record<string, unknown> };
  if (!parsedObj.object) {
    warnings.push("yarn.lock parsed to unexpected format");
    return { resolvedVersions, transitivePackages, warnings, format: "yarn.lock" };
  }

  const lockObject = parsedObj.object;

  // lockObject is a Map<string, { version: string, dependencies?: Record<string, string> }>
  // Keys are like "pkg@^1.0.0" or "pkg@npm:1.0.0" (Berry)
  // We need to identify which are direct (top-level) vs transitive

  // First pass: collect all entries with their version
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

  // Identify direct dependencies: those that appear as top-level dependencies
  // In Yarn v1, the root package's dependencies are listed with their version ranges
  // In Yarn v2+, similar but with different key format

  // Strategy: Direct deps are those where the key matches a pattern like "pkg@versionSpec"
  // and they have no parent referencing them. But the lockfile doesn't explicitly
  // mark root deps. Heuristic: direct deps are those that are NOT listed as a dependency
  // of any other package in the lockfile.

  const referencedByOthers = new Set<string>();

  for (const [, entry] of allEntries) {
    if (entry.dependencies) {
      for (const depName of Object.keys(entry.dependencies)) {
        // Find the entry that matches this dependency
        for (const [key] of allEntries) {
          // Key format: "pkg@version" or "pkg@npm:version" or "pkg@^1.0.0"
          if (key.startsWith(`${depName}@`)) {
            referencedByOthers.add(key);
          }
        }
      }
    }
  }

  // Direct deps = all entries not referenced by others
  // Transitive deps = entries referenced by others

  for (const [key, entry] of allEntries) {
    const isDirect = !referencedByOthers.has(key);

    // Extract package name from key (before @)
    const atIndex = key.lastIndexOf("@");
    const pkgName = atIndex > 0 ? key.slice(0, atIndex) : key;
    const versionSpec = atIndex > 0 ? key.slice(atIndex + 1) : "*";

    if (isDirect) {
      // Direct dependency - store with both exact key and name-only
      resolvedVersions.set(`${pkgName}@${versionSpec}`, entry.version);
      resolvedVersions.set(pkgName, entry.version);
    } else {
      // Transitive dependency
      transitivePackages.add(pkgName);
      resolvedVersions.set(pkgName, entry.version);
    }

    // Also collect transitive deps from this entry's dependencies
    if (entry.dependencies) {
      for (const [depName, depSpec] of Object.entries(entry.dependencies)) {
        if (!referencedByOthers.has(`${depName}@${depSpec}`) && !referencedByOthers.has(depName)) {
          // This dep might not have its own entry yet - check
          transitivePackages.add(depName);
        }
        const depEntry = allEntries.get(`${depName}@${depSpec}`) ?? allEntries.get(depName);
        if (depEntry) {
          resolvedVersions.set(depName, depEntry.version);
        }
      }
    }
  }

  // Second pass: ensure all transitive deps have versions
  for (const pkgName of transitivePackages) {
    if (!resolvedVersions.has(pkgName)) {
      // Try to find it in allEntries
      for (const [key, entry] of allEntries) {
        if (key.startsWith(`${pkgName}@`)) {
          resolvedVersions.set(pkgName, entry.version);
          break;
        }
      }
    }
  }

  return { resolvedVersions, transitivePackages, warnings, format: "yarn.lock" };
}
