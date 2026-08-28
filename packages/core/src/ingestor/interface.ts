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

export type { Ecosystem };

export interface ParsedDependency {
  package_name: string;
  version_spec: string;
  dep_type: "production" | "development" | "peer" | "optional" | "transitive";
  /** Populated from lock file parsing — the concrete version actually installed */
  resolved_version?: string | null;
  /** True if this dependency was not declared in the manifest but only appears in the lock file */
  is_transitive?: boolean;
}

export interface IngestorResult {
  ecosystem: Ecosystem;
  dependencies: ParsedDependency[];
  /** True if a lock file was available; affects score confidence */
  lock_file_present: boolean;
  /**
   * True if a manifest file was actually found and successfully parsed —
   * even if it turned out to declare zero dependencies. False when there
   * was no manifest to work with at all for this ecosystem (missing,
   * unparseable, or — for ecosystems with a fallback source, like PyPI's
   * requirements.txt — none of the candidate sources resolved). The caller
   * uses this to distinguish "we analyzed this repo and it's genuinely
   * dependency-free" (stays ingestionStatus: "complete") from "we couldn't
   * identify a project for this ecosystem here at all" (ingestionStatus:
   * "skipped"). Named generically rather than after any one ecosystem's
   * manifest format — renamed from package_json_resolved in ADR 0022,
   * Phase 6, when a second ecosystem's manifest shape (pyproject.toml/
   * requirements.txt, not JSON) made the original name misleading.
   */
  manifest_resolved: boolean;
  /** True if a lock file was successfully parsed (not just detected) */
  lock_file_parsed?: boolean;
  /** Format of the parsed lock file, if any */
  lock_file_format?:
    | "package-lock.json"
    | "pnpm-lock.yaml"
    | "yarn.lock"
    | "poetry.lock"
    | "Pipfile.lock"
    | "pdm.lock"
    | "go.sum";
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
