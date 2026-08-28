/**
 * LocalNpmIngestor
 *
 * Implements EcosystemIngestor for the npm ecosystem via local filesystem
 * reads, for the Phase 4 CLI: a repo path on disk has no GitHub URL and no
 * existing DB row, so there's nothing to fetch remotely — this reads
 * package.json (and reads/parses lock files) directly from the cloned repo on
 * disk instead.
 *
 * Shares parsePackageJsonContent (npm-parse.ts) with NpmIngestor (the
 * HTTP-based Phase 1 ingestor) so a package.json is interpreted identically
 * regardless of source — only how the raw bytes and lock-file presence are
 * obtained differs between the two.
 *
 * What this does NOT do:
 *   - Fetch transitive dependencies (beyond what's in the lock file)
 *   - Resolve version ranges to concrete versions
 *
 * ADR: docs/adr/0003-npm-ecosystem-first.md
 *      docs/adr/0038-lock-file-parsing.md
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EcosystemIngestor, IngestorResult } from "./interface.js";
import { LOCK_FILE_NAMES, parsePackageJsonContent } from "./npm-parse.js";

/** Node fs errors carry a `code` string; narrow rather than trusting `any`. */
function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export class LocalNpmIngestor implements EcosystemIngestor {
  readonly ecosystem = "npm" as const;

  /**
   * Parse dependencies from a local, already-cloned repo directory.
   *
   * @param repoPath - local filesystem path to the repo root (the directory
   *   containing package.json), e.g. "." or "/Users/mico/code/my-project"
   */
  async parseDependencies(repoPath: string): Promise<IngestorResult> {
    const packageJsonPath = join(repoPath, "package.json");

    const raw = await this.readPackageJsonRaw(packageJsonPath);

    // Skip the lock-file read entirely when there's no package.json
    // to resolve confidence against.
    const { lockFileContent, lockFileName, lockFilePresent } =
      raw === null
        ? { lockFileContent: null, lockFileName: null, lockFilePresent: false }
        : await this.readLockFile(repoPath);

    return parsePackageJsonContent(
      raw,
      lockFilePresent,
      packageJsonPath,
      lockFileContent,
      lockFileName,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Read the raw text of package.json from disk.
   * Returns null if the file doesn't exist (ENOENT).
   * Throws on any other filesystem error (permissions, package.json being a
   * directory, etc.) — parsing/validating the content itself is
   * parsePackageJsonContent's job, not this method's.
   */
  private async readPackageJsonRaw(packageJsonPath: string): Promise<string | null> {
    try {
      return await readFile(packageJsonPath, "utf-8");
    } catch (err) {
      if (isNodeErrnoException(err) && err.code === "ENOENT") {
        return null;
      }
      throw new Error(`Failed to read ${packageJsonPath}: ${String(err)}`);
    }
  }

  /**
   * Read the lock file content (package-lock.json or yarn.lock) from disk.
   * Returns the content, the name of the file found, and a boolean for presence.
   * Tries package-lock.json first, then yarn.lock, then checks pnpm-lock.yaml presence.
   */
  private async readLockFile(repoPath: string): Promise<{
    lockFileContent: string | null;
    lockFileName: string | null;
    lockFilePresent: boolean;
  }> {
    // First, try to read and parse package-lock.json or yarn.lock
    for (const name of LOCK_FILE_NAMES) {
      if (name === "pnpm-lock.yaml") continue; // not yet supported for parsing
      try {
        const content = await readFile(join(repoPath, name), "utf-8");
        return { lockFileContent: content, lockFileName: name, lockFilePresent: true };
      } catch {
        // Continue to next lock file
      }
    }

    // If no parsable lock file found, check for pnpm-lock.yaml presence
    try {
      await access(join(repoPath, "pnpm-lock.yaml"));
      return { lockFileContent: null, lockFileName: "pnpm-lock.yaml", lockFilePresent: true };
    } catch {
      // Ignore
    }

    return { lockFileContent: null, lockFileName: null, lockFilePresent: false };
  }
}
