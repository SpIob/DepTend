/**
 * LocalGoIngestor
 *
 * Implements EcosystemIngestor for the Go ecosystem via local filesystem
 * reads, for the CLI: a repo path on disk has no GitHub URL and no existing
 * DB row, so there's nothing to fetch remotely — this reads go.mod (and
 * reads/parses go.sum) directly from the cloned repo on disk instead.
 *
 * Shares parseGoModContent (go-parse.ts) with GoIngestor (the HTTP-based
 * ingestor) so a go.mod is interpreted identically regardless of source —
 * only how the raw bytes and lock-file presence are obtained differs
 * between the two. Mirrors local-npm.ts's split from npm.ts exactly.
 *
 * ADR: docs/adr/0024-phase7-go-ecosystem.md
 *      docs/adr/0038-lock-file-parsing.md
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EcosystemIngestor, IngestorResult } from "./interface.js";
import { GO_LOCK_FILE_NAMES, parseGoModContent } from "./go-parse.js";
import { isNodeErrnoException } from "./parse-guards.js";

export class LocalGoIngestor implements EcosystemIngestor {
  readonly ecosystem = "go" as const;

  /**
   * Parse dependencies from a local, already-cloned repo directory.
   *
   * @param repoPath - local filesystem path to the repo root (the directory
   *   containing go.mod), e.g. "." or "/Users/mico/code/my-project"
   * @param signal - accepted for interface conformance with the HTTP-based
   *   GoIngestor (ADR 0041). Filesystem reads are not abortable in a useful
   *   way, so this implementation ignores the signal — the parameter exists
   *   so the same `EcosystemIngestor[]` can mix HTTP- and filesystem-backed
   *   ingestors without TypeScript variance complaints.
   */
  async parseDependencies(repoPath: string, _signal?: AbortSignal): Promise<IngestorResult> {
    const goModPath = join(repoPath, "go.mod");

    const raw = await this.readGoModRaw(goModPath);

    // Skip the lock-file read entirely when there's no go.mod to
    // resolve confidence against — same optimization as GoIngestor, and
    // parseGoModContent would ignore the value anyway when raw is null.
    const { lockFileContent, lockFileName, lockFilePresent } =
      raw === null
        ? { lockFileContent: null, lockFileName: null, lockFilePresent: false }
        : await this.readLockFile(repoPath);

    return parseGoModContent(raw, lockFilePresent, goModPath, lockFileContent, lockFileName);
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
   * Read the lock file content (go.sum) from disk.
   * Returns the content, the name of the file found, and a boolean for presence.
   */
  private async readLockFile(repoPath: string): Promise<{
    lockFileContent: string | null;
    lockFileName: string | null;
    lockFilePresent: boolean;
  }> {
    for (const name of GO_LOCK_FILE_NAMES) {
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
