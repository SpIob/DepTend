/**
 * pyproject.toml / requirements.txt parsing — pure, no I/O
 *
 * Interprets already-obtained manifest content (raw text, or null if none
 * was found) into an IngestorResult. How the bytes were obtained is
 * deliberately not this module's concern — PyPIIngestor gets them via HTTP
 * fetch against a GitHub raw content URL, LocalPyPIIngestor via filesystem
 * reads against a cloned repo path. Both call parsePyPIManifests() so a
 * repo's PyPI dependencies are interpreted identically regardless of where
 * the bytes came from — mirrors npm-parse.ts's own fetch/parse split.
 *
 * Scope (ADR 0022, Decision 2):
 *   - Primary source: pyproject.toml, PEP 621 tables only —
 *     [project.dependencies] (-> dep_type "production") and
 *     [project.optional-dependencies] (-> dep_type "optional", one entry
 *     per extra, all extras flattened together). Poetry's
 *     [tool.poetry.dependencies] table (non-PEP-508 version syntax, e.g.
 *     "^1.4.2") is explicitly out of scope for Phase 6.
 *   - Fallback source: requirements.txt, tried whenever pyproject.toml
 *     doesn't yield a definitive PEP 621 dependency list — i.e. it's
 *     missing entirely, isn't valid TOML, or is valid TOML with no
 *     top-level [project.dependencies] key at all (covers Poetry-style and
 *     other non-PEP-621 pyproject.toml files, which would otherwise look
 *     like "a real project with zero dependencies" rather than "we don't
 *     parse this tool's table shape").
 *   - A pyproject.toml with an explicit `dependencies = []` (PEP-621-valid,
 *     genuinely empty) is resolved on its own — requirements.txt is not
 *     consulted in that case, mirroring how a genuinely-empty package.json
 *     stays resolved rather than falling through to some other source.
 *   - requirements.txt has no dev/optional distinction — every entry maps
 *     to dep_type "production".
 *   - Environment markers (`; python_version >= "3.8"`) are parsed off but
 *     not evaluated — a marker-gated dependency is still ingested
 *     unconditionally. Explicit Phase 6 scope boundary, not a silent gap.
 *   - PEP 508 direct references (`name @ https://...`) are accepted; the
 *     URL itself becomes version_spec, exactly as npm accepts a git-URL
 *     version spec today — downstream PEP 440 parsing will simply not
 *     recognize it as a range and fall back to an "unknown" bump size,
 *     same behavior npm already has for non-semver-range specs.
 *
 * ADR: docs/adr/0022-phase6-pypi-ecosystem.md
 */

import { parse as parseToml, TomlError } from "smol-toml";
import type { IngestorResult, ParsedDependency } from "./interface.js";
import { parsePoetryLockContent } from "./poetry-lock-parse.js";
import { parsePipfileLockContent } from "./pipfile-lock-parse.js";
import { parsePdmLockContent } from "./pdm-lock-parse.js";
import { mergeManifestWithLock } from "./lock-parse.js";

/** Minimal shape we care about from a pyproject.toml */
interface PyProjectToml {
  project?: {
    dependencies?: unknown;
    "optional-dependencies"?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Known Python lock file names — presence detected but not parsed in
 * Phase 6, same "detect, don't parse" treatment npm's LOCK_FILE_NAMES gets.
 * poetry.lock and Pipfile.lock are included even though Poetry/Pipenv's own
 * manifest tables are out of scope — a project can still have committed one
 * of these while also shipping a PEP-621-compliant pyproject.toml or a
 * requirements.txt.
 */
export const PYTHON_LOCK_FILE_NAMES = ["poetry.lock", "Pipfile.lock", "pdm.lock"] as const;

/**
 * Parses already-fetched/read pyproject.toml and requirements.txt content
 * into structured dependencies. Exactly one of the two sources "wins" per
 * the fallback rule described in the module docstring above.
 *
 * @param pyprojectRaw - raw pyproject.toml text, or null if none was found
 *   (e.g. HTTP 404, or ENOENT on a local read).
 * @param requirementsRaw - raw requirements.txt text, or null if none was
 *   found. Only consulted when pyprojectRaw doesn't resolve on its own.
 * @param lockFilePresent - whether a Python lock file was detected at the
 *   same location. Ignored when neither manifest resolves (mirrors npm:
 *   with nothing to resolve confidence against, there's no point reporting
 *   it either way).
 * @param pyprojectSource - human-readable description of where the
 *   pyproject.toml content came from, used only in warning messages.
 * @param requirementsSource - same, for requirements.txt.
 * @param lockFileContent - optional raw content of the lock file
 * @param lockFileName - name of the lock file (used to select the right parser)
 */
export function parsePyPIManifests(
  pyprojectRaw: string | null,
  requirementsRaw: string | null,
  lockFilePresent: boolean,
  pyprojectSource: string,
  requirementsSource: string,
  lockFileContent: string | null = null,
  lockFileName: string | null = null,
): IngestorResult {
  const pyprojectAttempt = attemptPyprojectToml(pyprojectRaw, pyprojectSource);

  if (pyprojectAttempt.resolved) {
    return finish(
      pyprojectAttempt.dependencies,
      pyprojectAttempt.warnings,
      lockFilePresent,
      lockFileContent,
      lockFileName,
    );
  }

  // pyproject.toml didn't yield a definitive PEP 621 dependency list —
  // fall through to requirements.txt, carrying pyproject's warnings along
  // so the reason for falling back stays visible.
  const requirementsAttempt = attemptRequirementsTxt(requirementsRaw, requirementsSource);
  const warnings = [...pyprojectAttempt.warnings, ...requirementsAttempt.warnings];

  if (requirementsAttempt.resolved) {
    return finish(
      requirementsAttempt.dependencies,
      warnings,
      lockFilePresent,
      lockFileContent,
      lockFileName,
    );
  }

  warnings.push("No usable pyproject.toml or requirements.txt found. Repository skipped.");
  return {
    ecosystem: "pypi",
    dependencies: [],
    lock_file_present: false,
    manifest_resolved: false,
    warnings,
  };
}

function finish(
  dependencies: ParsedDependency[],
  warnings: string[],
  lockFilePresent: boolean,
  lockFileContent: string | null,
  lockFileName: string | null,
): IngestorResult {
  const allWarnings = [...warnings];

  // If lock file content was provided, parse and merge it
  if (lockFileContent && lockFileName && lockFilePresent) {
    let lockResult;
    if (lockFileName === "poetry.lock") {
      lockResult = parsePoetryLockContent(lockFileContent);
    } else if (lockFileName === "Pipfile.lock") {
      lockResult = parsePipfileLockContent(lockFileContent);
    } else if (lockFileName === "pdm.lock") {
      lockResult = parsePdmLockContent(lockFileContent);
    } else {
      allWarnings.push(
        `Lock file format ${lockFileName} not yet supported for parsing — falling back to manifest only.`,
      );
      lockResult = null;
    }

    if (lockResult) {
      return mergeManifestWithLock(dependencies, lockResult, "pypi", allWarnings);
    }
  }

  if (!lockFilePresent) {
    allWarnings.push(
      "No lock file detected (poetry.lock, Pipfile.lock, pdm.lock). " +
        "Dependency versions are unresolved; confidence scores will be lower.",
    );
  }

  if (dependencies.length === 0) {
    allWarnings.push("Manifest contains no dependency entries.");
  }

  return {
    ecosystem: "pypi",
    dependencies,
    lock_file_present: lockFilePresent,
    manifest_resolved: true,
    warnings: allWarnings,
  };
}

// ---------------------------------------------------------------------------
// pyproject.toml (PEP 621)
// ---------------------------------------------------------------------------

interface PyprojectAttempt {
  resolved: boolean;
  dependencies: ParsedDependency[];
  warnings: string[];
}

function attemptPyprojectToml(raw: string | null, source: string): PyprojectAttempt {
  if (raw === null) {
    return { resolved: false, dependencies: [], warnings: [] };
  }

  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    const detail = err instanceof TomlError ? err.message : String(err);
    return {
      resolved: false,
      dependencies: [],
      warnings: [
        `pyproject.toml at ${source} is not valid TOML (${detail}) — trying requirements.txt.`,
      ],
    };
  }

  const doc = parsed as PyProjectToml;
  const project = doc.project;

  // No `project === null` check here, unlike npm-parse.ts's JSON equivalent
  // — TOML has no null/nil literal at all (string, integer, float, boolean,
  // datetime, array, table are the only value types), so a parsed TOML
  // value can never be null.
  if (typeof project !== "object" || Array.isArray(project)) {
    return {
      resolved: false,
      dependencies: [],
      warnings: [
        `pyproject.toml at ${source} has no [project] table (likely a Poetry-style or ` +
          `other non-PEP-621 file, out of scope for Phase 6) — trying requirements.txt.`,
      ],
    };
  }

  if (!("dependencies" in project)) {
    return {
      resolved: false,
      dependencies: [],
      warnings: [
        `pyproject.toml at ${source} has a [project] table but no "dependencies" key ` +
          `(likely a Poetry-style or other non-PEP-621 file, out of scope for Phase 6) — ` +
          `trying requirements.txt.`,
      ],
    };
  }

  const warnings: string[] = [];
  const dependencies: ParsedDependency[] = [];

  const rawDeps = project.dependencies;
  if (!Array.isArray(rawDeps)) {
    warnings.push(
      `"project.dependencies" in pyproject.toml at ${source} is not an array — skipped.`,
    );
  } else {
    for (const entry of rawDeps) {
      pushParsedPep508(entry, "project.dependencies", source, "production", dependencies, warnings);
    }
  }

  const optional = project["optional-dependencies"];
  if (optional !== undefined) {
    if (!isStringRecord(optional)) {
      warnings.push(
        `"project.optional-dependencies" in pyproject.toml at ${source} is not a valid object — skipped.`,
      );
    } else {
      for (const [extraName, entries] of Object.entries(optional)) {
        if (!Array.isArray(entries)) {
          warnings.push(
            `"project.optional-dependencies.${extraName}" in pyproject.toml at ${source} is not an array — skipped.`,
          );
          continue;
        }
        for (const entry of entries) {
          pushParsedPep508(
            entry,
            `project.optional-dependencies.${extraName}`,
            source,
            "optional",
            dependencies,
            warnings,
          );
        }
      }
    }
  }

  return { resolved: true, dependencies, warnings };
}

// ---------------------------------------------------------------------------
// requirements.txt
// ---------------------------------------------------------------------------

interface RequirementsAttempt {
  resolved: boolean;
  dependencies: ParsedDependency[];
  warnings: string[];
}

/** Line-start pragmas that reference something other than a plain requirement */
const REQUIREMENTS_PRAGMA_PREFIXES = [
  "-r",
  "--requirement",
  "-c",
  "--constraint",
  "-e",
  "--editable",
  "-i",
  "--index-url",
  "--extra-index-url",
  "--find-links",
  "--no-index",
  "--trusted-host",
  "--hash",
] as const;

function attemptRequirementsTxt(raw: string | null, source: string): RequirementsAttempt {
  if (raw === null) {
    return { resolved: false, dependencies: [], warnings: [] };
  }

  const dependencies: ParsedDependency[] = [];
  const warnings: string[] = [];

  const lines = raw.split(/\r?\n/);

  for (const rawLine of lines) {
    // A backslash at end-of-line is a pip continuation marker; Phase 6
    // doesn't join continued lines (rare in practice for plain requirement
    // entries) — strip it and parse what's on this line, warn if it left
    // something unparseable.
    const line = rawLine.trim();

    if (line === "" || line.startsWith("#")) continue;

    if (REQUIREMENTS_PRAGMA_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      warnings.push(`Skipping unsupported requirements.txt line at ${source}: "${line}"`);
      continue;
    }

    // Strip an inline comment: a '#' counts as starting a comment only when
    // preceded by whitespace or at the very start (already handled above),
    // to avoid clipping '#egg=' fragments inside URLs on lines this pass
    // doesn't already skip.
    const withoutComment = line.replace(/\s+#.*$/, "").trim();
    if (withoutComment === "") continue;

    const parsedEntry = parsePep508(withoutComment);
    if (parsedEntry === null) {
      warnings.push(`Skipping unparseable requirements.txt line at ${source}: "${line}"`);
      continue;
    }

    if (!isValidPyPIPackageName(parsedEntry.name)) {
      warnings.push(
        `Skipping invalid package name "${parsedEntry.name}" in requirements.txt at ${source}.`,
      );
      continue;
    }

    dependencies.push({
      package_name: parsedEntry.name,
      version_spec: parsedEntry.versionSpec,
      dep_type: "production",
    });
  }

  return { resolved: true, dependencies, warnings };
}

// ---------------------------------------------------------------------------
// PEP 508 dependency-specifier parsing (shared by both sources above)
// ---------------------------------------------------------------------------

interface Pep508Entry {
  name: string;
  versionSpec: string;
}

/**
 * Parses a single PEP 508 dependency specifier string into a name and a
 * version_spec. A pragmatic subset of the full grammar — enough to extract
 * name and version constraints without pulling in a dedicated PEP 508
 * parser, mirroring npm-parse.ts's own "pragmatic subset" approach to name
 * validation.
 *
 * Handles: "name", "name>=1.0,<2.0", "name[extra]>=1.0",
 * "name; python_version >= \"3.8\"" (marker parsed off and discarded — see
 * module docstring), "name @ https://..." (direct reference — the URL
 * becomes version_spec verbatim).
 *
 * Returns null if no name could be extracted at all.
 */
function parsePep508(entry: string): Pep508Entry | null {
  // Split off the marker (everything after the first top-level ';'), if any.
  const semicolon = entry.indexOf(";");
  const withoutMarker = (semicolon === -1 ? entry : entry.slice(0, semicolon)).trim();

  // Deliberately permissive at extraction time — including names that start
  // with '.'/'_'/'-', which PEP 503 disallows. isValidPyPIPackageName() is
  // the single authority on validity; extracting a technically-invalid name
  // here (rather than failing to match at all) lets the caller report a
  // specific "invalid package name" warning instead of a vaguer
  // "unparseable entry" one.
  const nameMatch = /^[A-Za-z0-9._-]+/.exec(withoutMarker);
  if (nameMatch === null) return null;

  // Index 0 (the whole match) is always defined on a successful exec()
  // result, unlike numbered capture groups — no capturing group needed
  // here since the whole pattern is the name.
  const name = nameMatch[0];
  let rest = withoutMarker.slice(name.length).trim();

  // Optional extras: "[extra1,extra2]" — informational only, package
  // identity for OSV/registry lookups doesn't change based on extras, so
  // they're parsed off and discarded rather than folded into the name.
  if (rest.startsWith("[")) {
    const closeBracket = rest.indexOf("]");
    if (closeBracket !== -1) {
      rest = rest.slice(closeBracket + 1).trim();
    }
  }

  if (rest === "") {
    return { name, versionSpec: "*" };
  }

  // Direct reference form: "name @ https://..." — the URL becomes
  // version_spec verbatim, same treatment npm gives a git-URL version spec.
  if (rest.startsWith("@")) {
    const url = rest.slice(1).trim();
    return { name, versionSpec: url === "" ? "*" : url };
  }

  return { name, versionSpec: rest };
}

function pushParsedPep508(
  entry: unknown,
  fieldDescription: string,
  source: string,
  depType: ParsedDependency["dep_type"],
  dependencies: ParsedDependency[],
  warnings: string[],
): void {
  if (typeof entry !== "string" || entry.trim() === "") {
    warnings.push(
      `Skipping non-string or empty entry in "${fieldDescription}" in pyproject.toml at ${source}.`,
    );
    return;
  }

  const parsedEntry = parsePep508(entry.trim());
  if (parsedEntry === null) {
    warnings.push(
      `Skipping unparseable entry "${entry}" in "${fieldDescription}" in pyproject.toml at ${source}.`,
    );
    return;
  }

  if (!isValidPyPIPackageName(parsedEntry.name)) {
    warnings.push(
      `Skipping invalid package name "${parsedEntry.name}" in "${fieldDescription}" in pyproject.toml at ${source}.`,
    );
    return;
  }

  dependencies.push({
    package_name: parsedEntry.name,
    version_spec: parsedEntry.versionSpec,
    dep_type: depType,
  });
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates PyPI package names against PEP 503's normalization grammar:
 * https://peps.python.org/pep-0503/#normalized-names
 *
 * Unlike npm, PyPI names are case-insensitive but commonly *written* with
 * mixed case (Flask, SQLAlchemy) — this deliberately does not force
 * lowercase the way npm's validator does; doing so would wrongly reject a
 * large share of real-world PyPI names. A pragmatic subset, same spirit as
 * npm-parse.ts's isValidPackageName.
 */
function isValidPyPIPackageName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  return /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name);
}
