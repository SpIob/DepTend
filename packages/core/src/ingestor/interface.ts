/**
 * Ingestor interface
 *
 * All ecosystem ingestors (npm Phase 1, pypi Phase 6+) must implement this
 * interface. Adding a new ecosystem requires only a new class that satisfies
 * EcosystemIngestor — no changes to the core pipeline.
 *
 * ADR: docs/adr/0003-npm-ecosystem-first.md
 */

import type { Ecosystem } from "../db/schema.js";

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
  /**
   * True if a manifest file was actually found and successfully parsed as
   * a JSON object — even if it turned out to declare zero dependencies.
   * False when there was no manifest to work with at all (missing,
   * invalid JSON, or not an object) — the caller uses this to distinguish
   * "we analyzed this repo and it's genuinely dependency-free" (stays
   * ingestionStatus: "complete") from "we couldn't identify an npm
   * project here at all" (ingestionStatus: "skipped").
   */
  package_json_resolved: boolean;
  /** Warnings about data quality to surface in the UI */
  warnings: string[];
}

export interface EcosystemIngestor {
  readonly ecosystem: Ecosystem;

  /**
   * Parse dependencies from a repo's manifest files.
   * @param repoPath - meaning is implementation-specific: NpmIngestor
   *   expects a GitHub raw content base URL for remote fetching;
   *   LocalNpmIngestor expects a local filesystem path to a cloned repo.
   *   Each concrete ingestor documents which it accepts.
   */
  parseDependencies(repoPath: string): Promise<IngestorResult>;
}
