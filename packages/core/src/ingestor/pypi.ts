/**
 * PyPIIngestor
 *
 * Implements EcosystemIngestor for the PyPI ecosystem (Phase 6) via HTTP
 * fetch against GitHub's raw content API. Mirrors NpmIngestor's shape
 * exactly — the only real difference is that PyPI has two candidate
 * manifest files instead of one (see ADR 0022, Decision 2), so this fetches
 * both and lets parsePyPIManifests (pypi-parse.ts) own the fallback logic
 * between them.
 *
 * Fetching strategy:
 *   repoPath is a GitHub raw content base URL of the form:
 *     https://raw.githubusercontent.com/<owner>/<name>/<branch>
 *
 *   Fetches /pyproject.toml and /requirements.txt in parallel (independent
 *   requests, no reason to serialize them), and fetches the first available
 *   Python lock file (poetry.lock, Pipfile.lock, pdm.lock) for parsing.
 *   Both manifests are always fetched unconditionally, even when pyproject.toml
 *   alone would resolve — simpler than a "fetch requirements.txt only if needed"
 *   two-stage flow, and keeps 100% of the fallback decision inside
 *   parsePyPIManifests rather than splitting it across this file too.
 *
 * Fetching (this file) and parsing (pypi-parse.ts's parsePyPIManifests) are
 * deliberately separate — LocalPyPIIngestor reads the same manifest shapes
 * from a local filesystem path instead, and shares the exact same parsing
 * logic rather than duplicating it.
 *
 * ADR: docs/adr/0022-phase6-pypi-ecosystem.md
 *      docs/adr/0038-lock-file-parsing.md
 */

import type { EcosystemIngestor, IngestorResult } from "./interface.js";
import { fetchWithRetry, type FetchRetryOptions } from "./fetch-retry.js";
import { PYTHON_LOCK_FILE_NAMES, parsePyPIManifests } from "./pypi-parse.js";

export class PyPIIngestor implements EcosystemIngestor {
  readonly ecosystem = "pypi" as const;

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
   *   winning the parallel race can cancel the in-flight pypi fetch(es)
   *   instead of letting them complete and be discarded.
   */
  async parseDependencies(repoPath: string, signal?: AbortSignal): Promise<IngestorResult> {
    // Normalise: strip any trailing slash so URL joins are consistent
    const base = repoPath.replace(/\/$/, "");
    const pyprojectUrl = `${base}/pyproject.toml`;
    const requirementsUrl = `${base}/requirements.txt`;

    const [pyprojectRaw, requirementsRaw] = await Promise.all([
      this.fetchRaw(pyprojectUrl, signal),
      this.fetchRaw(requirementsUrl, signal),
    ]);

    // Skip the lock-file fetch entirely when neither candidate
    // manifest was found — parsePyPIManifests ignores lockFilePresent in
    // that case anyway (nothing to resolve confidence against), so there's
    // no point making the extra network calls. Mirrors NpmIngestor's same
    // optimization, just checking both sources instead of one.
    const { lockFileContent, lockFileName, lockFilePresent } =
      pyprojectRaw === null && requirementsRaw === null
        ? { lockFileContent: null, lockFileName: null, lockFilePresent: false }
        : await this.fetchLockFile(base, signal);

    return parsePyPIManifests(
      pyprojectRaw,
      requirementsRaw,
      lockFilePresent,
      pyprojectUrl,
      requirementsUrl,
      lockFileContent,
      lockFileName,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch the raw text of a manifest file from a raw GitHub URL.
   * Returns null if the file is missing (404).
   * Throws on network errors, unexpected HTTP statuses, or an unreadable
   * response body — parsing/validating the content itself is
   * parsePyPIManifests's job, not this method's.
   */
  private async fetchRaw(url: string, signal?: AbortSignal): Promise<string | null> {
    let response: Response;

    try {
      const init: RequestInit = { ...(signal !== undefined && { signal }) };
      response = await fetchWithRetry(url, init, this.fetchRetryOptions);
    } catch (err) {
      throw new Error(`Network error fetching ${url}: ${String(err)}`);
    }

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Unexpected HTTP ${String(response.status)} fetching ${url}`);
    }

    try {
      return await response.text();
    } catch (err) {
      throw new Error(`Failed to read response body from ${url}: ${String(err)}`);
    }
  }

  /**
   * Fetch the lock file content (poetry.lock, Pipfile.lock, or pdm.lock) and detect presence.
   * Returns the content (for parsable formats), the name of the file found, and a boolean for presence.
   * Tries poetry.lock first, then Pipfile.lock, then pdm.lock.
   */
  private async fetchLockFile(
    base: string,
    signal?: AbortSignal,
  ): Promise<{
    lockFileContent: string | null;
    lockFileName: string | null;
    lockFilePresent: boolean;
  }> {
    // First, try to fetch and parse known lock files
    for (const name of PYTHON_LOCK_FILE_NAMES) {
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
