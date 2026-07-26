/**
 * LocalGoIngestor
 *
 * Implements EcosystemIngestor for the Go ecosystem via local filesystem
 * reads, for the CLI: a repo path on disk has no GitHub URL and no existing
 * DB row, so there's nothing to fetch remotely — this reads go.mod (and
 * detects go.sum) directly from the cloned repo on disk instead.
 *
 * Shares parseGoModContent (go-parse.ts) with GoIngestor (the HTTP-based
 * ingestor) so a go.mod is interpreted identically regardless of source —
 * only how the raw bytes and lock-file presence are obtained differs
 * between the two. Mirrors local-npm.ts's split from npm.ts exactly.
 *
 * What this does NOT do (same scope limits as GoIngestor):
 *   - Parse or resolve go.sum
 *   - Fetch transitive (indirect) dependencies
 *   - Resolve version ranges to concrete versions
 *   - Multi-module repos (a nested go.mod outside repoPath's root)
 *
 * ADR: docs/adr/0024-phase7-go-ecosystem.md
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EcosystemIngestor, IngestorResult } from "./interface.js";
import { GO_LOCK_FILE_NAMES, parseGoModContent } from "./go-parse.js";

/** Node fs errors carry a `code` string; narrow rather than trusting `any`. */
function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export class LocalGoIngestor implements EcosystemIngestor {
  readonly ecosystem = "go" as const;

  /**
   * Parse dependencies from a local, already-cloned repo directory.
   *
   * @param repoPath - local filesystem path to the repo root (the directory
   *   containing go.mod), e.g. "." or "/Users/mico/code/my-project"
   */
  async parseDependencies(repoPath: string): Promise<IngestorResult> {
    const goModPath = join(repoPath, "go.mod");

    const raw = await this.readGoModRaw(goModPath);

    // Skip the lock-file existence check entirely when there's no go.mod to
    // resolve confidence against — same optimization as GoIngestor, and
    // parseGoModContent would ignore the value anyway when raw is null.
    const lockFilePresent = raw === null ? false : await this.detectLockFile(repoPath);

    return parseGoModContent(raw, lockFilePresent, goModPath);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Read the raw text of go.mod from disk.
   * Returns null if the file doesn't exist (ENOENT).
   * Throws on any other filesystem error (permissions, go.mod being a
   * directory, etc.) — parsing/validating the content itself is
   * parseGoModContent's job, not this method's.
   */
  private async readGoModRaw(goModPath: string): Promise<string | null> {
    try {
      return await readFile(goModPath, "utf-8");
    } catch (err) {
      if (isNodeErrnoException(err) && err.code === "ENOENT") {
        return null;
      }
      throw new Error(`Failed to read ${goModPath}: ${String(err)}`);
    }
  }

  /**
   * Checks for each known Go lock file name in the repo root (just go.sum
   * today — see GoIngestor's equivalent for why this stays a loop). Returns
   * true if any is present. Intentionally silent — absence is not an
   * error, just recorded as a warning by parseGoModContent.
   */
  private async detectLockFile(repoPath: string): Promise<boolean> {
    const checks = GO_LOCK_FILE_NAMES.map(async (name) => {
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
