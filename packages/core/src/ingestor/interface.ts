/**
 * Ingestor interface
 *
 * All ecosystem ingestors (npm Phase 1, pypi Phase 6+) must implement this
 * interface. Adding a new ecosystem requires only a new class that satisfies
 * EcosystemIngestor — no changes to the core pipeline.
 *
 * ADR: docs/adr/0003-npm-ecosystem-first.md
 */

import type { Ecosystem } from "../db/types.js";

export interface ParsedDependency {
  package_name: string;
  version_spec: string;
  dep_type: "production" | "development" | "peer" | "optional";
}

export interface IngestorResult {
  ecosystem: Ecosystem;
  dependencies: ParsedDependency[];
  /** True if a lock file was available; affects score confidence */
  lock_file_present: boolean;
  /** Warnings about data quality to surface in the UI */
  warnings: string[];
}

export interface EcosystemIngestor {
  readonly ecosystem: Ecosystem;

  /**
   * Parse dependencies from a repo's manifest files.
   * @param repoPath - local filesystem path to the cloned repo, OR
   *                   a GitHub raw content base URL for remote fetching
   */
  parseDependencies(repoPath: string): Promise<IngestorResult>;
}
