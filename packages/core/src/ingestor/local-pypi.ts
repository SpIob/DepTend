/**
 * LocalPyPIIngestor
 *
 * Implements EcosystemIngestor for the PyPI ecosystem via local filesystem
 * reads, for the CLI: a repo path on disk has no GitHub URL and no
 * existing DB row, so there's nothing to fetch remotely — this reads
 * pyproject.toml and requirements.txt (and detects lock files) directly
 * from the cloned repo on disk instead. Mirrors LocalNpmIngestor's shape
 * exactly.
 *
 * Shares parsePyPIManifests (pypi-parse.ts) with PyPIIngestor (the
 * HTTP-based ingestor) so a repo's PyPI dependencies are interpreted
 * identically regardless of source — only how the raw bytes and lock-file
 * presence are obtained differs between the two.
 *
 * What this does NOT do (same scope limits as PyPIIngestor):
 *   - Parse or resolve lock files
 *   - Parse Poetry's [tool.poetry.dependencies] table
 *   - Fetch transitive dependencies
 *   - Resolve version ranges to concrete versions
 *
 * ADR: docs/adr/0022-phase6-pypi-ecosystem.md
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EcosystemIngestor, IngestorResult } from "./interface.js";
import { PYTHON_LOCK_FILE_NAMES, parsePyPIManifests } from "./pypi-parse.js";

/** Node fs errors carry a `code` string; narrow rather than trusting `any`. */
function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export class LocalPyPIIngestor implements EcosystemIngestor {
  readonly ecosystem = "pypi" as const;

  /**
   * Parse dependencies from a local, already-cloned repo directory.
   *
   * @param repoPath - local filesystem path to the repo root (the
   *   directory containing pyproject.toml/requirements.txt), e.g. "." or
   *   "/Users/mico/code/my-project"
   */
  async parseDependencies(repoPath: string): Promise<IngestorResult> {
    const pyprojectPath = join(repoPath, "pyproject.toml");
    const requirementsPath = join(repoPath, "requirements.txt");

    const [pyprojectRaw, requirementsRaw] = await Promise.all([
      this.readRaw(pyprojectPath),
      this.readRaw(requirementsPath),
    ]);

    // Skip the lock-file existence checks entirely when neither candidate
    // manifest was found — same optimization as PyPIIngestor, and
    // parsePyPIManifests would ignore the value anyway in that case.
    const lockFilePresent =
      pyprojectRaw === null && requirementsRaw === null
        ? false
        : await this.detectLockFile(repoPath);

    return parsePyPIManifests(
      pyprojectRaw,
      requirementsRaw,
      lockFilePresent,
      pyprojectPath,
      requirementsPath,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Read the raw text of a manifest file from disk.
   * Returns null if the file doesn't exist (ENOENT).
   * Throws on any other filesystem error (permissions, the path being a
   * directory, etc.) — parsing/validating the content itself is
   * parsePyPIManifests's job, not this method's.
   */
  private async readRaw(path: string): Promise<string | null> {
    try {
      return await readFile(path, "utf-8");
    } catch (err) {
      if (isNodeErrnoException(err) && err.code === "ENOENT") {
        return null;
      }
      throw new Error(`Failed to read ${path}: ${String(err)}`);
    }
  }

  /**
   * Checks for each known Python lock file name in the repo root. Returns
   * true if any is present. Intentionally silent — absence is not an
   * error, just recorded as a warning by parsePyPIManifests.
   */
  private async detectLockFile(repoPath: string): Promise<boolean> {
    const checks = PYTHON_LOCK_FILE_NAMES.map(async (name) => {
      try {
        await access(join(repoPath, name));
        return true;
      } catch {
        return false;
      }
    });

    const results = await Promise.all(checks);
    return results.some(Boolean);
  }
}
