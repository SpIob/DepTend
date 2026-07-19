/**
 * LocalNpmIngestor
 *
 * Implements EcosystemIngestor for the npm ecosystem via local filesystem
 * reads, for the Phase 4 CLI: a repo path on disk has no GitHub URL and no
 * existing DB row, so there's nothing to fetch remotely — this reads
 * package.json (and detects lock files) directly from the cloned repo on
 * disk instead.
 *
 * Shares parsePackageJsonContent (npm-parse.ts) with NpmIngestor (the
 * HTTP-based Phase 1 ingestor) so a package.json is interpreted identically
 * regardless of source — only how the raw bytes and lock-file presence are
 * obtained differs between the two.
 *
 * What this does NOT do (same scope limits as NpmIngestor):
 *   - Parse or resolve lock files
 *   - Fetch transitive dependencies
 *   - Resolve version ranges to concrete versions
 *
 * ADR: docs/adr/0003-npm-ecosystem-first.md
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

    // Skip the lock-file existence checks entirely when there's no
    // package.json to resolve confidence against — same optimization as
    // NpmIngestor, and parsePackageJsonContent would ignore the value
    // anyway when raw is null.
    const lockFilePresent = raw === null ? false : await this.detectLockFile(repoPath);

    return parsePackageJsonContent(raw, lockFilePresent, packageJsonPath);
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
   * Checks for each known lock file name in the repo root. Returns true if
   * any is present. Intentionally silent — absence is not an error, just
   * recorded as a warning by parsePackageJsonContent.
   */
  private async detectLockFile(repoPath: string): Promise<boolean> {
    const checks = LOCK_FILE_NAMES.map(async (name) => {
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
