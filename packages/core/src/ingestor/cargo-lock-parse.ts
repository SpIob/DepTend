/**
 * Cargo.lock parsing — pure, no I/O
 *
 * Parses Cargo's lock file via smol-toml (already a dependency since ADR
 * 0022 — Cargo.lock is TOML, confirmed against a real lock file during ADR
 * 0063's grounding). The shape this project needs is small:
 *
 *   [[package]]
 *   name = "serde"
 *   version = "1.0.219"
 *   source = "registry+https://github.com/rust-lang/crates.io-index"
 *   ...
 *
 * Every [[package]] entry — direct or transitive, registry, git, or
 * path-sourced — carries name + version, and mergeManifestWithLock() is
 * what turns that into resolved direct deps + lock-only transitive rows.
 * All names go into transitivePackages: a Cargo.lock alone cannot
 * distinguish direct from transitive (exactly go.sum's situation —
 * ADR 0038), so the manifest diff is left to mergeManifestWithLock(),
 * which already skips any transitive candidate the manifest declares.
 * The `source` field is deliberately not read (no filtering on
 * registry-vs-git-vs-path: a manifest-declared path/git dependency still
 * has a resolvable name + version), and the lock format's
 * `version = 3|4` field is not read — name/version are stable across
 * formats.
 *
 * A Cargo.lock with no [[package]] entries at all (a workspace root's
 * empty lock file) parses successfully with zero resolved versions.
 *
 * ADR: docs/adr/0063-cargo-ecosystem.md (Decision 2)
 */

import { parse as parseToml, TomlError } from "smol-toml";
import type { LockFileParseResult } from "./lock-parse.js";

interface CargoLockPackage {
  name?: unknown;
  version?: unknown;
  [key: string]: unknown;
}

interface CargoLockDocument {
  package?: unknown;
  [key: string]: unknown;
}

export function parseCargoLockContent(content: string): LockFileParseResult | null {
  const warnings: string[] = [];
  const resolvedVersions = new Map<string, string>();
  const transitivePackages = new Set<string>();

  let parsed: unknown;
  try {
    parsed = parseToml(content);
  } catch (err) {
    // Caller (finalizeParseResult) treats null as "unparseable lock file —
    // fall back to manifest only", which is exactly the right degradation
    // for malformed TOML.
    const detail = err instanceof TomlError ? err.message : String(err);
    warnings.push(`Cargo.lock is not valid TOML (${detail}) — falling back to manifest only.`);
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push("Cargo.lock did not parse to a TOML table — falling back to manifest only.");
    return null;
  }

  const doc = parsed as CargoLockDocument;
  const packages = doc.package;

  if (!Array.isArray(packages)) {
    // A lock file with no [[package]] array is unusual but structurally
    // valid TOML — treat as an empty lock, not a parse failure.
    return { resolvedVersions, transitivePackages, warnings, format: "Cargo.lock" };
  }

  for (const entry of packages) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      warnings.push("Skipping a non-table [[package]] entry in Cargo.lock.");
      continue;
    }

    const pkg = entry as CargoLockPackage;
    const name = typeof pkg.name === "string" ? pkg.name.trim() : "";
    const version = typeof pkg.version === "string" ? pkg.version.trim() : "";

    if (name === "" || version === "") {
      warnings.push("Skipping a Cargo.lock [[package]] entry missing a name or version.");
      continue;
    }

    // First occurrence wins — mirrors go-sum-parse.ts. A well-formed
    // Cargo.lock never lists the same name twice (cargo dedupes by
    // name+version per resolution graph), so a duplicate is a warning
    // about a hand-edited or corrupt file, not a silent override.
    if (resolvedVersions.has(name)) {
      warnings.push(`Cargo.lock lists "${name}" more than once — keeping the first occurrence.`);
      continue;
    }
    resolvedVersions.set(name, version);
    transitivePackages.add(name);
  }

  return { resolvedVersions, transitivePackages, warnings, format: "Cargo.lock" };
}
