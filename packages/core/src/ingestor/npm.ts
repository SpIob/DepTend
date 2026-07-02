/**
 * NpmIngestor
 *
 * Implements EcosystemIngestor for the npm ecosystem (Phase 1).
 *
 * Fetching strategy:
 *   repoPath is a GitHub raw content base URL of the form:
 *     https://raw.githubusercontent.com/<owner>/<name>/<branch>
 *
 *   The ingestor appends /package.json to fetch the manifest, and
 *   checks for the presence of a lock file (without parsing it —
 *   lock file parsing is deferred to a later phase).
 *
 * What this does NOT do (out of scope for Phase 1):
 *   - Parse or resolve lock files
 *   - Fetch transitive dependencies
 *   - Resolve version ranges to concrete versions (that requires the
 *     npm registry and is done by the registry fetcher in Step 4)
 *
 * ADR: docs/adr/0003-npm-ecosystem-first.md
 */

import type { EcosystemIngestor, IngestorResult, ParsedDependency } from "./interface.js";

// ---------------------------------------------------------------------------
// Types for raw package.json shape
// ---------------------------------------------------------------------------

/** Minimal shape we care about from a package.json */
interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/** Known lock file names — presence detected but not parsed in Phase 1 */
const LOCK_FILE_NAMES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"] as const;

// ---------------------------------------------------------------------------
// NpmIngestor
// ---------------------------------------------------------------------------

export class NpmIngestor implements EcosystemIngestor {
  readonly ecosystem = "npm" as const;

  /**
   * Parse dependencies from a GitHub repository.
   *
   * @param repoPath - GitHub raw content base URL, e.g.:
   *   https://raw.githubusercontent.com/owner/name/main
   */
  async parseDependencies(repoPath: string): Promise<IngestorResult> {
    const warnings: string[] = [];

    // Normalise: strip any trailing slash so URL joins are consistent
    const base = repoPath.replace(/\/$/, "");

    // ------------------------------------------------------------------
    // 1. Fetch package.json
    // ------------------------------------------------------------------
    const packageJson = await this.fetchPackageJson(base, warnings);

    if (packageJson === null) {
      // No package.json at all — nothing to ingest for this repo
      return {
        ecosystem: "npm",
        dependencies: [],
        lock_file_present: false,
        warnings,
      };
    }

    // ------------------------------------------------------------------
    // 2. Detect lock file presence (no parsing)
    // ------------------------------------------------------------------
    const lockFilePresent = await this.detectLockFile(base);

    if (!lockFilePresent) {
      warnings.push(
        "No lock file detected (package-lock.json, pnpm-lock.yaml, yarn.lock). " +
          "Dependency versions are unresolved; confidence scores will be lower.",
      );
    }

    // ------------------------------------------------------------------
    // 3. Parse dependency sections
    // ------------------------------------------------------------------
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
      warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch and parse package.json from the raw GitHub URL.
   * Returns null if the file is missing (404) or unparseable.
   * Throws on unexpected network errors.
   */
  private async fetchPackageJson(base: string, warnings: string[]): Promise<PackageJson | null> {
    const url = `${base}/package.json`;
    let response: Response;

    try {
      response = await fetch(url);
    } catch (err) {
      throw new Error(`Network error fetching package.json from ${url}: ${String(err)}`);
    }

    if (response.status === 404) {
      warnings.push(`No package.json found at ${url}. Repository skipped.`);
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `Unexpected HTTP ${String(response.status)} fetching package.json from ${url}`,
      );
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch (err) {
      throw new Error(`Failed to read response body from ${url}: ${String(err)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnings.push(`package.json at ${url} is not valid JSON — skipping repository.`);
      return null;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      warnings.push(`package.json at ${url} is not a JSON object — skipping repository.`);
      return null;
    }

    return parsed as PackageJson;
  }

  /**
   * HEAD-request each known lock file name. Returns true if any is present.
   * Intentionally silent — absence is not an error, just recorded as a warning
   * by the caller.
   */
  private async detectLockFile(base: string): Promise<boolean> {
    const checks = LOCK_FILE_NAMES.map(async (name) => {
      try {
        const res = await fetch(`${base}/${name}`, { method: "HEAD" });
        return res.ok;
      } catch {
        return false;
      }
    });

    const results = await Promise.all(checks);
    return results.some(Boolean);
  }
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
