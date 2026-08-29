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
 *   The ingestor appends /go.mod to fetch the manifest, and fetches go.sum
 *   for parsing.
 *
 * Single-source shape (like npm.ts), not the primary/fallback shape pypi.ts
 * needed — go.mod has no equivalent of a requirements.txt fallback.
 *
 * Fetching (this file) and parsing (go-parse.ts's parseGoModContent) are
 * deliberately separate — LocalGoIngestor reads the same go.mod shape from
 * a local filesystem path instead, and shares the exact same parsing logic
 * rather than duplicating it, mirroring npm.ts/local-npm.ts's split.
 *
 * ADR: docs/adr/0024-phase7-go-ecosystem.md
 *      docs/adr/0038-lock-file-parsing.md
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
   * @param signal - optional AbortSignal from detectEcosystem() (ADR 0041).
   *   Forwarded to every underlying fetch() call so a higher-priority probe
   *   winning the parallel race can cancel the in-flight go fetch(es)
   *   instead of letting them complete and be discarded.
   */
  async parseDependencies(repoPath: string, signal?: AbortSignal): Promise<IngestorResult> {
    // Normalise: strip any trailing slash so URL joins are consistent
    const base = repoPath.replace(/\/$/, "");
    const url = `${base}/go.mod`;

    const raw = await this.fetchGoModRaw(url, signal);

    // Skip the lock-file fetch entirely when there's no go.mod to
    // resolve confidence against — parseGoModContent would ignore
    // lockFilePresent in that case anyway, so there's no point making the
    // extra network call.
    const { lockFileContent, lockFileName, lockFilePresent } =
      raw === null
        ? { lockFileContent: null, lockFileName: null, lockFilePresent: false }
        : await this.fetchLockFile(base, signal);

    return parseGoModContent(raw, lockFilePresent, url, lockFileContent, lockFileName);
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
  private async fetchGoModRaw(url: string, signal?: AbortSignal): Promise<string | null> {
    let response: Response;

    try {
      const init: RequestInit = { ...(signal !== undefined && { signal }) };
      response = await fetchWithRetry(url, init, this.fetchRetryOptions);
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
   * Fetch the lock file content (go.sum) and detect presence.
   * Returns the content, the name of the file found, and a boolean for presence.
   */
  private async fetchLockFile(
    base: string,
    signal?: AbortSignal,
  ): Promise<{
    lockFileContent: string | null;
    lockFileName: string | null;
    lockFilePresent: boolean;
  }> {
    for (const name of GO_LOCK_FILE_NAMES) {
      try {
        const init: RequestInit = { ...(signal !== undefined && { signal }) };
        const res = await fetchWithRetry(`${base}/${name}`, init, this.fetchRetryOptions);
        if (res.ok) {
          const content = await res.text();
          return { lockFileContent: content, lockFileName: name, lockFilePresent: true };
        }
      } catch {
        // Continue to next lock file
      }
    }

    return { lockFileContent: null, lockFileName: null, lockFilePresent: false };
  }
}
