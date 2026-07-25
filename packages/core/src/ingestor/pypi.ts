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
 *   requests, no reason to serialize them), and checks for the presence of
 *   a Python lock file (without parsing it — same "detect, don't parse"
 *   treatment npm's lock files get). Both manifests are always fetched
 *   unconditionally, even when pyproject.toml alone would resolve —
 *   simpler than a "fetch requirements.txt only if needed" two-stage flow,
 *   and keeps 100% of the fallback decision inside parsePyPIManifests
 *   rather than splitting it across this file too. Costs at most one extra
 *   HTTP request per repo; negligible at the current repo cap (ADR 0022).
 *
 * Fetching (this file) and parsing (pypi-parse.ts's parsePyPIManifests) are
 * deliberately separate — LocalPyPIIngestor reads the same manifest shapes
 * from a local filesystem path instead, and shares the exact same parsing
 * logic rather than duplicating it.
 *
 * What this does NOT do (out of scope for Phase 6, see ADR 0022):
 *   - Parse or resolve lock files (poetry.lock, Pipfile.lock, pdm.lock)
 *   - Parse Poetry's [tool.poetry.dependencies] table
 *   - Fetch transitive dependencies
 *   - Resolve version ranges to concrete versions (that's the registry
 *     fetcher's job)
 *
 * ADR: docs/adr/0022-phase6-pypi-ecosystem.md
 */

import type { EcosystemIngestor, IngestorResult } from "./interface.js";
import { PYTHON_LOCK_FILE_NAMES, parsePyPIManifests } from "./pypi-parse.js";

export class PyPIIngestor implements EcosystemIngestor {
  readonly ecosystem = "pypi" as const;

  /**
   * Parse dependencies from a GitHub repository.
   *
   * @param repoPath - GitHub raw content base URL, e.g.:
   *   https://raw.githubusercontent.com/owner/name/main
   */
  async parseDependencies(repoPath: string): Promise<IngestorResult> {
    // Normalise: strip any trailing slash so URL joins are consistent
    const base = repoPath.replace(/\/$/, "");
    const pyprojectUrl = `${base}/pyproject.toml`;
    const requirementsUrl = `${base}/requirements.txt`;

    const [pyprojectRaw, requirementsRaw] = await Promise.all([
      this.fetchRaw(pyprojectUrl),
      this.fetchRaw(requirementsUrl),
    ]);

    // Skip the lock-file HEAD requests entirely when neither candidate
    // manifest was found — parsePyPIManifests ignores lockFilePresent in
    // that case anyway (nothing to resolve confidence against), so there's
    // no point making the extra network calls. Mirrors NpmIngestor's same
    // optimization, just checking both sources instead of one.
    const lockFilePresent =
      pyprojectRaw === null && requirementsRaw === null ? false : await this.detectLockFile(base);

    return parsePyPIManifests(
      pyprojectRaw,
      requirementsRaw,
      lockFilePresent,
      pyprojectUrl,
      requirementsUrl,
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
  private async fetchRaw(url: string): Promise<string | null> {
    let response: Response;

    try {
      response = await fetch(url);
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
   * HEAD-request each known Python lock file name. Returns true if any is
   * present. Intentionally silent — absence is not an error, just recorded
   * as a warning by parsePyPIManifests.
   */
  private async detectLockFile(base: string): Promise<boolean> {
    const checks = PYTHON_LOCK_FILE_NAMES.map(async (name) => {
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
