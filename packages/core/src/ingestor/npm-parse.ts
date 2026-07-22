/**
 * package.json parsing — pure, no I/O
 *
 * Interprets already-obtained package.json content (raw text, or null if
 * none was found) plus a lock-file-presence flag into an IngestorResult.
 * How the bytes and lock-file presence were obtained is deliberately not
 * this module's concern — NpmIngestor gets them via HTTP fetch against a
 * GitHub raw content URL, LocalNpmIngestor via filesystem reads against a
 * cloned repo path. Both call parsePackageJsonContent() so a package.json
 * is interpreted identically regardless of where it came from.
 *
 * Extracted from npm.ts, which originally mixed fetching and parsing in
 * one class (Phase 1, before there was a second ingestor to share with).
 *
 * ADR: docs/adr/0003-npm-ecosystem-first.md
 */

import type { IngestorResult, ParsedDependency } from "./interface.js";

/** Minimal shape we care about from a package.json */
export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/** Known lock file names — presence detected but not parsed in Phase 1 */
export const LOCK_FILE_NAMES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"] as const;

/**
 * Parses already-fetched/read package.json content into structured
 * dependencies.
 *
 * @param raw - the raw package.json text, or null if none was found at all
 *   (e.g. HTTP 404, or ENOENT on a local read). When null, lock-file
 *   presence isn't checked either — mirrors the original behavior: with no
 *   package.json there's nothing to resolve confidence against, so the
 *   caller's lockFilePresent value is ignored and the result always reports
 *   lock_file_present: false in this case.
 * @param lockFilePresent - whether a lock file was detected at the same
 *   location. Ignored when raw is null (see above).
 * @param source - human-readable description of where this content came
 *   from, used only in warning messages — a URL for HTTP fetches, a file
 *   path for local reads.
 */
export function parsePackageJsonContent(
  raw: string | null,
  lockFilePresent: boolean,
  source: string,
): IngestorResult {
  const warnings: string[] = [];

  if (raw === null) {
    warnings.push(`No package.json found at ${source}. Repository skipped.`);
    return {
      ecosystem: "npm",
      dependencies: [],
      lock_file_present: false,
      package_json_resolved: false,
      warnings,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push(`package.json at ${source} is not valid JSON — skipping repository.`);
    return {
      ecosystem: "npm",
      dependencies: [],
      lock_file_present: false,
      package_json_resolved: false,
      warnings,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push(`package.json at ${source} is not a JSON object — skipping repository.`);
    return {
      ecosystem: "npm",
      dependencies: [],
      lock_file_present: false,
      package_json_resolved: false,
      warnings,
    };
  }

  const packageJson = parsed as PackageJson;

  if (!lockFilePresent) {
    warnings.push(
      "No lock file detected (package-lock.json, pnpm-lock.yaml, yarn.lock). " +
        "Dependency versions are unresolved; confidence scores will be lower.",
    );
  }

  const dependencies: ParsedDependency[] = [];

  const sections: {
    field: keyof PackageJson;
    dep_type: ParsedDependency["dep_type"];
  }[] = [
    { field: "dependencies", dep_type: "production" },
    { field: "devDependencies", dep_type: "development" },
    { field: "peerDependencies", dep_type: "peer" },
    { field: "optionalDependencies", dep_type: "optional" },
  ];

  for (const { field, dep_type } of sections) {
    const section = packageJson[field];

    if (section === undefined) continue;

    if (!isStringRecord(section)) {
      warnings.push(`"${String(field)}" in package.json is not a valid object — skipped.`);
      continue;
    }

    for (const [package_name, version_spec] of Object.entries(section)) {
      if (!isValidPackageName(package_name)) {
        warnings.push(`Skipping invalid package name "${package_name}" in "${String(field)}".`);
        continue;
      }

      if (typeof version_spec !== "string" || version_spec.trim() === "") {
        warnings.push(
          `Skipping "${package_name}" in "${String(field)}": version spec is missing or empty.`,
        );
        continue;
      }

      dependencies.push({
        package_name,
        version_spec: version_spec.trim(),
        dep_type,
      });
    }
  }

  if (dependencies.length === 0) {
    warnings.push("package.json contains no dependency entries.");
  }

  return {
    ecosystem: "npm",
    dependencies,
    lock_file_present: lockFilePresent,
    package_json_resolved: true,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates npm package names against the npm registry spec:
 * https://github.com/npm/validate-npm-package-name
 *
 * This is a pragmatic subset — enough to reject obviously bad entries
 * without pulling in a dependency.
 */
function isValidPackageName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0 || name.length > 214) {
    return false;
  }
  // Scoped: @scope/name
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    if (slash === -1 || slash === 1 || slash === name.length - 1) return false;
    const scope = name.slice(1, slash);
    const pkg = name.slice(slash + 1);
    return isValidNameSegment(scope) && isValidNameSegment(pkg);
  }
  return isValidNameSegment(name);
}

function isValidNameSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  // Must not start with a dot or underscore (npm spec)
  if (segment.startsWith(".") || segment.startsWith("_")) return false;
  // Allowed: lowercase letters, digits, hyphens, dots, underscores
  return /^[a-z0-9\-._]+$/.test(segment);
}
