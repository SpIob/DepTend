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
 *   fetches the lock file (package-lock.json or yarn.lock) for parsing.
 *
 * Fetching (this file) and parsing (npm-parse.ts's parsePackageJsonContent)
 * are deliberately separate — LocalNpmIngestor (Phase 4) reads the same
 * package.json shape from a local filesystem path instead, and shares the
 * exact same parsing logic rather than duplicating it.
 *
 * What this does NOT do:
 *   - Fetch transitive dependencies (beyond what's in the lock file)
 *   - Resolve version ranges to concrete versions (that requires the
 *     npm registry and is done by the registry fetcher in Step 4)
 *
 * ADR: docs/adr/0003-npm-ecosystem-first.md
 *      docs/adr/0038-lock-file-parsing.md
 */

import type { EcosystemIngestor, IngestorResult } from "./interface.js";
import { fetchWithRetry, type FetchRetryOptions } from "./fetch-retry.js";
import { LOCK_FILE_NAMES, parsePackageJsonContent } from "./npm-parse.js";

export class NpmIngestor implements EcosystemIngestor {
  readonly ecosystem = "npm" as const;

  private readonly fetchRetryOptions: FetchRetryOptions;

  /**
   * @param fetchRetryOptions - transport tuning for the raw-content fetches.
   *   Ingestion keeps the defaults; interactive callers (manifest-check's
   *   submission pre-check) tighten them.
   */
  constructor(fetchRetryOptions: FetchRetryOptions = {}) {
    this.fetchRetryOptions = fetchRetryOptions;
  }

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

    // Skip the lock-file fetch entirely when there's no package.json
    // to resolve confidence against.
    const { lockFileContent, lockFileName, lockFilePresent } =
      raw === null
        ? { lockFileContent: null, lockFileName: null, lockFilePresent: false }
        : await this.fetchLockFile(base);

    return parsePackageJsonContent(raw, lockFilePresent, url, lockFileContent, lockFileName);
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
      response = await fetchWithRetry(url, undefined, this.fetchRetryOptions);
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
   * Fetch the lock file content (package-lock.json or yarn.lock) and detect presence.
   * Returns the content (for parsable formats), the name of the file found, and a boolean for presence.
   * Tries package-lock.json first, then yarn.lock, then checks pnpm-lock.yaml presence via HEAD.
   */
  private async fetchLockFile(base: string): Promise<{
    lockFileContent: string | null;
    lockFileName: string | null;
    lockFilePresent: boolean;
  }> {
    // First, try to fetch and parse package-lock.json or yarn.lock
    for (const name of LOCK_FILE_NAMES) {
      if (name === "pnpm-lock.yaml") continue; // not yet supported for parsing
      try {
        const res = await fetchWithRetry(`${base}/${name}`, undefined, this.fetchRetryOptions);
        if (res.ok) {
          const content = await res.text();
          return { lockFileContent: content, lockFileName: name, lockFilePresent: true };
        }
      } catch {
        // Continue to next lock file
      }
    }

    // If no parsable lock file found, check for pnpm-lock.yaml presence via HEAD
    try {
      const res = await fetchWithRetry(
        `${base}/pnpm-lock.yaml`,
        { method: "HEAD" },
        this.fetchRetryOptions,
      );
      if (res.ok) {
        return { lockFileContent: null, lockFileName: "pnpm-lock.yaml", lockFilePresent: true };
      }
    } catch {
      // Ignore
    }

    return { lockFileContent: null, lockFileName: null, lockFilePresent: false };
  }
}
