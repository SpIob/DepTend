/**
 * LocalPyPIIngestor
 *
 * Implements EcosystemIngestor for the PyPI ecosystem via local filesystem
 * reads, for the CLI: a repo path on disk has no GitHub URL and no
 * existing DB row, so there's nothing to fetch remotely — this reads
 * pyproject.toml and requirements.txt (and reads/parses lock files) directly
 * from the cloned repo on disk instead. Mirrors LocalNpmIngestor's shape
 * exactly.
 *
 * Shares parsePyPIManifests (pypi-parse.ts) with PyPIIngestor (the
 * HTTP-based ingestor) so a repo's PyPI dependencies are interpreted
 * identically regardless of source — only how the raw bytes and lock-file
 * presence are obtained differs between the two.
 *
 * ADR: docs/adr/0022-phase6-pypi-ecosystem.md
 *      docs/adr/0038-lock-file-parsing.md
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EcosystemIngestor, IngestorResult } from "./interface.js";
import { PYTHON_LOCK_FILE_NAMES, parsePyPIManifests } from "./pypi-parse.js";
import { isNodeErrnoException } from "./parse-guards.js";

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

    // Skip the lock-file read entirely when neither candidate
    // manifest was found — same optimization as PyPIIngestor, and
    // parsePyPIManifests would ignore the value anyway in that case.
    const { lockFileContent, lockFileName, lockFilePresent } =
      pyprojectRaw === null && requirementsRaw === null
        ? { lockFileContent: null, lockFileName: null, lockFilePresent: false }
        : await this.readLockFile(repoPath);

    return parsePyPIManifests(
      pyprojectRaw,
      requirementsRaw,
      lockFilePresent,
      pyprojectPath,
      requirementsPath,
      lockFileContent,
      lockFileName,
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
   * Read the lock file content (poetry.lock, Pipfile.lock, or pdm.lock) from disk.
   * Returns the content, the name of the file found, and a boolean for presence.
   * Tries poetry.lock first, then Pipfile.lock, then pdm.lock.
   */
  private async readLockFile(repoPath: string): Promise<{
    lockFileContent: string | null;
    lockFileName: string | null;
    lockFilePresent: boolean;
  }> {
    // First, try to read and parse known lock files
    for (const name of PYTHON_LOCK_FILE_NAMES) {
      try {
        const content = await readFile(join(repoPath, name), "utf-8");
        return { lockFileContent: content, lockFileName: name, lockFilePresent: true };
      } catch {
        // Continue to next lock file
      }
    }

    return { lockFileContent: null, lockFileName: null, lockFilePresent: false };
  }
}
