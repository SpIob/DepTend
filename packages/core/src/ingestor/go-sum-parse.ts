/**
 * go.sum parsing — pure, no I/O
 *
 * Parses Go's module checksum file format.
 * Each line: <module> <version> <hash>
 * Multiple lines per module (different versions, go.mod + zip hashes).
 * We only care about the version for each module.
 *
 * ADR: docs/adr/0038-lock-file-parsing.md
 */

import type { LockFileParseResult } from "./lock-parse.js";

/**
 * Parse go.sum content.
 * Returns resolved versions for all modules found in the checksum file.
 * Note: go.sum contains checksums for ALL modules (direct + transitive),
 * so we can't distinguish direct vs transitive from this file alone.
 * All modules are treated as having resolved versions; transitive detection
 * is not possible from go.sum alone.
 */
export function parseGoSumContent(content: string): LockFileParseResult {
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

  return { resolvedVersions, transitivePackages, warnings, format: "go.sum" };
}
