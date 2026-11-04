/**
 * Cargo.toml parsing — pure, no I/O
 *
 * Interprets already-obtained Cargo.toml content into an IngestorResult,
 * mirroring go-parse.ts's fetch/parse split: CargoIngestor gets the bytes
 * via HTTP fetch against a GitHub raw content URL, LocalCargoIngestor via
 * filesystem reads; both call parseCargoTomlContent() so the manifest is
 * interpreted identically regardless of provenance.
 *
 * Scope (ADR 0063, Decision 2):
 *   - Only the root manifest's standard dependency tables are read:
 *       [dependencies]        -> dep_type "production"
 *       [dev-dependencies]    -> dep_type "development"
 *       [build-dependencies]  -> dep_type "production" (required to build)
 *     Entries carrying `optional = true` map to dep_type "optional".
 *   - Three value shapes, all handled:
 *       crate = "1.0"
 *       crate = { version = "1.0", features = [...], optional = true }
 *       crate = { workspace = true }  — resolved against the same file's
 *         [workspace.dependencies] when present, else version_spec "*"
 *         with a warning.
 *   - [target.'cfg(…)'.dependencies] tables, [patch]/[replace]/[exclude],
 *     and workspace member manifests are out of scope (ADR 0063) — they're
 *     separate TOML tables that never collide with the three dependency
 *     table names, so they're inert here, same treatment go-parse.ts gives
 *     replace/exclude/retract directives.
 *   - Requirement strings are captured verbatim, unvalidated — same choice
 *     npm-parse.ts already makes for package.json ranges. Cargo's own
 *     requirement grammar (caret/tilde/comparison/wildcard) is left to the
 *     semver-based scorers downstream, exactly as npm's is.
 *
 * A root Cargo.toml whose [workspace] section has no [dependencies] but
 * also no standard dependency tables (a virtual workspace root) parses as
 * manifest_resolved: true with zero dependencies — same precedent as
 * npm's empty package.json and gorilla/mux's empty go.mod. Only a missing
 * file, or one that fails TOML parsing entirely, becomes
 * manifest_resolved: false.
 *
 * ADR: docs/adr/0063-cargo-ecosystem.md
 */

import { parse as parseToml, TomlError } from "smol-toml";
import type { IngestorResult, ParsedDependency } from "./interface.js";
import { parseCargoLockContent } from "./cargo-lock-parse.js";
import { mergeManifestWithLock } from "./lock-parse.js";

/**
 * Cargo's lock-file equivalent — presence detected and (unlike Phase 1/6's
 * original scope) content parsed via cargo-lock-parse.ts. Kept as a named
 * array for shape consistency with LOCK_FILE_NAMES /
 * PYTHON_LOCK_FILE_NAMES / GO_LOCK_FILE_NAMES and so callers (cargo.ts,
 * local-cargo.ts) have one canonical place to reference it.
 */
export const CARGO_LOCK_FILE_NAMES = ["Cargo.lock"] as const;

/** Minimal shape we care about from a Cargo.toml */
interface CargoDependencySpec {
  version?: unknown;
  optional?: unknown;
  workspace?: unknown;
  [key: string]: unknown;
}

interface CargoTomlDocument {
  dependencies?: unknown;
  "dev-dependencies"?: unknown;
  "build-dependencies"?: unknown;
  workspace?: {
    dependencies?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface CargoDepValue {
  spec: string;
  optional: boolean;
}

export function parseCargoTomlContent(
  raw: string | null,
  lockFilePresent: boolean,
  source: string,
  lockFileContent: string | null = null,
  lockFileName: string | null = null,
): IngestorResult {
  const warnings: string[] = [];

  if (raw === null) {
    warnings.push(`No Cargo.toml found at ${source}. Repository skipped.`);
    return unresolved(warnings);
  }

  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    const detail = err instanceof TomlError ? err.message : String(err);
    warnings.push(`Cargo.toml at ${source} is not valid TOML (${detail}). Repository skipped.`);
    return unresolved(warnings);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push(`Cargo.toml at ${source} did not parse to a TOML table. Repository skipped.`);
    return unresolved(warnings);
  }

  const doc = parsed as CargoTomlDocument;
  const workspaceDeps = readWorkspaceDependencies(doc);
  const dependencies: ParsedDependency[] = [];

  collectFromTable(doc.dependencies, "production", source, workspaceDeps, dependencies, warnings);
  collectFromTable(
    doc["dev-dependencies"],
    "development",
    source,
    workspaceDeps,
    dependencies,
    warnings,
  );
  collectFromTable(
    doc["build-dependencies"],
    "production",
    source,
    workspaceDeps,
    dependencies,
    warnings,
  );

  // If lock file content was provided, parse and merge it
  if (lockFileContent && lockFileName && lockFilePresent) {
    if (lockFileName === "Cargo.lock") {
      const lockResult = parseCargoLockContent(lockFileContent);
      if (lockResult !== null) {
        return mergeManifestWithLock(dependencies, lockResult, "cargo", warnings);
      }
    } else {
      warnings.push(
        `Lock file format ${lockFileName} not yet supported for parsing — falling back to manifest only.`,
      );
    }
  }

  if (!lockFilePresent) {
    warnings.push(
      "No lock file detected (Cargo.lock). Dependency versions are unresolved; confidence scores will be lower.",
    );
  }

  if (dependencies.length === 0) {
    warnings.push("Cargo.toml contains no dependency entries.");
  }

  return {
    ecosystem: "cargo",
    dependencies,
    lock_file_present: lockFilePresent,
    manifest_resolved: true,
    warnings,
  };
}

function unresolved(warnings: string[]): IngestorResult {
  return {
    ecosystem: "cargo",
    dependencies: [],
    lock_file_present: false,
    manifest_resolved: false,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Dependency-table collection
// ---------------------------------------------------------------------------

/**
 * Walks one of the three standard dependency tables, pushing a
 * ParsedDependency for each parseable entry onto `dependencies`. A missing
 * table (undefined) contributes nothing; a malformed one is warned about
 * and skipped — never throw, report via warnings, per the ingestor
 * contract every ecosystem parser follows.
 */
function collectFromTable(
  table: unknown,
  depType: ParsedDependency["dep_type"],
  source: string,
  workspaceDeps: Record<string, unknown> | null,
  dependencies: ParsedDependency[],
  warnings: string[],
): void {
  if (table === undefined) return;

  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    warnings.push(`Skipping a malformed dependency table in Cargo.toml at ${source}.`);
    return;
  }

  for (const [crateName, value] of Object.entries(table as Record<string, unknown>)) {
    if (!isValidCrateName(crateName)) {
      warnings.push(`Skipping invalid crate name "${crateName}" in Cargo.toml at ${source}.`);
      continue;
    }

    const depValue = interpretDepValue(crateName, value, source, workspaceDeps, warnings);
    if (depValue === null) continue;

    dependencies.push({
      package_name: crateName,
      version_spec: depValue.spec,
      // An optional flag on any shape wins over the table's base type —
      // an optional dev-dependency is still, more specifically, optional.
      dep_type: depValue.optional ? "optional" : depType,
    });
  }
}

/**
 * Normalizes the three value shapes a Cargo.toml dependency entry can take
 * into {spec, optional}. Returns null (with a warning) for entries with
 * nothing usable.
 */
function interpretDepValue(
  crateName: string,
  value: unknown,
  source: string,
  workspaceDeps: Record<string, unknown> | null,
  warnings: string[],
): CargoDepValue | null {
  // Shape 1: crate = "1.0" — plain requirement string.
  if (typeof value === "string") {
    return { spec: value, optional: false };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    warnings.push(
      `Skipping "${crateName}" in Cargo.toml at ${source}: unsupported dependency value type.`,
    );
    return null;
  }

  const spec = value as CargoDependencySpec;

  // Shape 3: crate = { workspace = true } — inherited from
  // [workspace.dependencies] in this same file. When the workspace table
  // carries a version for this crate, use it; otherwise the constraints
  // are genuinely unknown and version_spec falls back to "*" (the same
  // convention mergeManifestWithLock uses for lock-only deps), with a
  // visible warning.
  if (spec.workspace === true) {
    const wsSpec = extractWorkspaceSpec(workspaceDeps?.[crateName]);
    if (wsSpec !== null) {
      return { spec: wsSpec, optional: false };
    }
    warnings.push(
      `Dependency "${crateName}" in Cargo.toml at ${source} is workspace-inherited but no workspace version was found — recording version_spec "*" with unknown resolved constraints.`,
    );
    return { spec: "*", optional: false };
  }

  // Shape 2: crate = { version = "1.0", ... }.
  if (typeof spec.version === "string" && spec.version.trim() !== "") {
    return {
      spec: spec.version,
      optional: spec.optional === true,
    };
  }

  // An inline table without a version: a git/path dependency (no version
  // requirement at all) is legitimate — record "*" so the entry still
  // exists and its lock-resolved version can drive advisory matching.
  if (hasNoVersionButHasSource(spec)) {
    return { spec: "*", optional: spec.optional === true };
  }

  warnings.push(
    `Skipping "${crateName}" in Cargo.toml at ${source}: no version requirement found.`,
  );
  return null;
}

/**
 * A dependency inline table with no `version` key is a git/path dependency
 * when it carries a `git`, `path`, or `branch`/`tag`/`rev` source key.
 */
function hasNoVersionButHasSource(spec: CargoDependencySpec): boolean {
  return "git" in spec || "path" in spec || "branch" in spec || "tag" in spec || "rev" in spec;
}

/**
 * Extracts the requirement string from a [workspace.dependencies] entry —
 * which can be a plain string ("1.0") or the same inline-table shape
 * ({ version = "1.0", features = [...] }).
 */
function extractWorkspaceSpec(wsValue: unknown): string | null {
  if (typeof wsValue === "string") return wsValue;
  if (typeof wsValue === "object" && wsValue !== null && !Array.isArray(wsValue)) {
    const version = (wsValue as CargoDependencySpec).version;
    if (typeof version === "string" && version.trim() !== "") return version;
  }
  return null;
}

function readWorkspaceDependencies(doc: CargoTomlDocument): Record<string, unknown> | null {
  // Threaded through `unknown` before narrowing: the CargoTomlDocument
  // interface asserts the parsed shape, but a TOML file can legally carry
  // a plain `workspace = "..."` key where a table was expected, so the
  // runtime value is narrowed from unknown, not from the asserted type.
  const workspace: unknown = doc.workspace;
  if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)) {
    return null;
  }
  const deps: unknown = (workspace as Record<string, unknown>).dependencies;
  if (typeof deps !== "object" || deps === null || Array.isArray(deps)) {
    return null;
  }
  return deps as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Validates a crate name against crates.io's own rules (per its registry
 * API docs): ASCII alphanumerics plus `-` and `_`, cannot consist only of
 * `-`/`_` characters, max 64 chars. Case is preserved verbatim in
 * package_name — crates.io names are case-sensitive in its API, and OSV
 * crates.io queries key on the exact manifest spelling.
 */
export function isValidCrateName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return false;
  return !/^[-_]+$/.test(name);
}
