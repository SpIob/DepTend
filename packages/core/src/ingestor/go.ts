/**
 * GoIngestor
 *
 * Implements EcosystemIngestor for the Go ecosystem (Phase 7) via HTTP
 * fetch against GitHub's raw content API.
 *
 * Fetching strategy:
 *   repoPath is a GitHub raw content base URL of the form:
 *     https://raw.githubusercontent.com/<owner>/<name>/<branch>
 *
 *   The ingestor appends /go.mod to fetch the manifest, and checks for the
 *   presence of go.sum (without parsing it — lock file parsing is deferred,
 *   same standing scope limit every ecosystem here has).
 *
 * Single-source shape (like npm.ts), not the primary/fallback shape pypi.ts
 * needed — go.mod has no equivalent of a requirements.txt fallback.
 *
 * Fetching (this file) and parsing (go-parse.ts's parseGoModContent) are
 * deliberately separate — LocalGoIngestor reads the same go.mod shape from
 * a local filesystem path instead, and shares the exact same parsing logic
 * rather than duplicating it, mirroring npm.ts/local-npm.ts's split.
 *
 * What this does NOT do (out of scope for Phase 7, same shape of deferral
 * as npm/PyPI):
 *   - Parse or resolve go.sum
 *   - Fetch transitive (indirect) dependencies
 *   - Resolve version ranges to concrete versions (that's the Go module
 *     proxy, done by GoRegistryFetcher, a later step)
 *   - Multi-module repos (a nested go.mod outside the repo root) — only the
 *     repo-root go.mod is read, same "root-only" scope every ecosystem here
 *     has had since Phase 1
 *
 * ADR: docs/adr/0024-phase7-go-ecosystem.md
 */

import type { EcosystemIngestor, IngestorResult } from "./interface.js";
import { fetchWithRetry, type FetchRetryOptions } from "./fetch-retry.js";
import { GO_LOCK_FILE_NAMES, parseGoModContent } from "./go-parse.js";

export class GoIngestor implements EcosystemIngestor {
  readonly ecosystem = "go" as const;

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
    const url = `${base}/go.mod`;

    const raw = await this.fetchGoModRaw(url);

    // Skip the lock-file HEAD request entirely when there's no go.mod to
    // resolve confidence against — parseGoModContent would ignore
    // lockFilePresent in that case anyway, so there's no point making the
    // extra network call.
    const lockFilePresent = raw === null ? false : await this.detectLockFile(base);

    return parseGoModContent(raw, lockFilePresent, url);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch the raw text of go.mod from the raw GitHub URL.
   * Returns null if the file is missing (404).
   * Throws on network errors, unexpected HTTP statuses, or an unreadable
   * response body — parsing/validating the content itself is
   * parseGoModContent's job, not this method's.
   */
  private async fetchGoModRaw(url: string): Promise<string | null> {
    let response: Response;

    try {
      response = await fetchWithRetry(url, undefined, this.fetchRetryOptions);
    } catch (err) {
      throw new Error(`Network error fetching go.mod from ${url}: ${String(err)}`);
    }

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Unexpected HTTP ${String(response.status)} fetching go.mod from ${url}`);
    }

    try {
      return await response.text();
    } catch (err) {
      throw new Error(`Failed to read response body from ${url}: ${String(err)}`);
    }
  }

  /**
   * HEAD-request each known Go lock file name (just go.sum today, but kept
   * as a loop over GO_LOCK_FILE_NAMES for shape-consistency with npm/PyPI's
   * multi-name equivalents). Returns true if any is present. Intentionally
   * silent — absence is not an error, just recorded as a warning by
   * parseGoModContent.
   */
  private async detectLockFile(base: string): Promise<boolean> {
    const checks = GO_LOCK_FILE_NAMES.map(async (name) => {
      try {
        const res = await fetchWithRetry(
          `${base}/${name}`,
          { method: "HEAD" },
          this.fetchRetryOptions,
        );
        return res.ok;
      } catch {
        return false;
      }
    });

    const results = await Promise.all(checks);
    return results.some(Boolean);
  }
}
