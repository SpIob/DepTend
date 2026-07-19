/**
 * NpmIngestor
 *
 * Implements EcosystemIngestor for the npm ecosystem (Phase 1) via HTTP
 * fetch against GitHub's raw content API.
 *
 * Fetching strategy:
 *   repoPath is a GitHub raw content base URL of the form:
 *     https://raw.githubusercontent.com/<owner>/<name>/<branch>
 *
 *   The ingestor appends /package.json to fetch the manifest, and
 *   checks for the presence of a lock file (without parsing it —
 *   lock file parsing is deferred to a later phase).
 *
 * Fetching (this file) and parsing (npm-parse.ts's parsePackageJsonContent)
 * are deliberately separate — LocalNpmIngestor (Phase 4) reads the same
 * package.json shape from a local filesystem path instead, and shares the
 * exact same parsing logic rather than duplicating it.
 *
 * What this does NOT do (out of scope for Phase 1):
 *   - Parse or resolve lock files
 *   - Fetch transitive dependencies
 *   - Resolve version ranges to concrete versions (that requires the
 *     npm registry and is done by the registry fetcher in Step 4)
 *
 * ADR: docs/adr/0003-npm-ecosystem-first.md
 */

import type { EcosystemIngestor, IngestorResult } from "./interface.js";
import { LOCK_FILE_NAMES, parsePackageJsonContent } from "./npm-parse.js";

export class NpmIngestor implements EcosystemIngestor {
  readonly ecosystem = "npm" as const;

  /**
   * Parse dependencies from a GitHub repository.
   *
   * @param repoPath - GitHub raw content base URL, e.g.:
   *   https://raw.githubusercontent.com/owner/name/main
   */
  async parseDependencies(repoPath: string): Promise<IngestorResult> {
    // Normalise: strip any trailing slash so URL joins are consistent
    const base = repoPath.replace(/\/$/, "");
    const url = `${base}/package.json`;

    const raw = await this.fetchPackageJsonRaw(url);

    // Skip the lock-file HEAD requests entirely when there's no package.json
    // to resolve confidence against — parsePackageJsonContent would ignore
    // lockFilePresent in that case anyway, so there's no point making the
    // extra network calls.
    const lockFilePresent = raw === null ? false : await this.detectLockFile(base);

    return parsePackageJsonContent(raw, lockFilePresent, url);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch the raw text of package.json from the raw GitHub URL.
   * Returns null if the file is missing (404).
   * Throws on network errors, unexpected HTTP statuses, or an unreadable
   * response body — parsing/validating the content itself is
   * parsePackageJsonContent's job, not this method's.
   */
  private async fetchPackageJsonRaw(url: string): Promise<string | null> {
    let response: Response;

    try {
      response = await fetch(url);
    } catch (err) {
      throw new Error(`Network error fetching package.json from ${url}: ${String(err)}`);
    }

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `Unexpected HTTP ${String(response.status)} fetching package.json from ${url}`,
      );
    }

    try {
      return await response.text();
    } catch (err) {
      throw new Error(`Failed to read response body from ${url}: ${String(err)}`);
    }
  }

  /**
   * HEAD-request each known lock file name. Returns true if any is present.
   * Intentionally silent — absence is not an error, just recorded as a warning
   * by parsePackageJsonContent.
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
