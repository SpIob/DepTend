/**
 * npm Registry Metadata Fetcher
 *
 * For each parsed dependency, fetches the `/latest` dist-tag from the npm
 * registry to populate three fields on the `dependencies` table:
 *
 *   - latestVersion   — the current published version (e.g. "4.18.1")
 *   - isDeprecated    — true when the package maintainer has marked it
 *   - deprecationNote — the deprecation message string, if present
 *
 * ...plus one field that is NOT persisted to the DB — `sourceRepo`, the
 * package's own GitHub repo parsed from the `repository` field already in
 * this same response (ADR 0029). It's recomputed fresh on every ingestion
 * run, same as `detectEcosystem`, rather than stored — see ADR 0029
 * Decision 1.
 *
 * API used: https://registry.npmjs.org/<package>/latest
 * No authentication required for public packages.
 * No new runtime dependencies — uses the global fetch API (Node 18+).
 *
 * The fetch / dedup / bounded-concurrency / response-shape-checking shell
 * lives in RegistryFetcher (registry-base.ts); this subclass only owns
 * the npm-specific bits: the URL shape, the version field name, and the
 * response-to-`PackageMetadata` mapping (deprecation + sourceRepo).
 *
 * Phase 1 scope — intentionally out of scope:
 *   - Resolving version specs to concrete versions (requires lock file or
 *     full version list fetch — deferred to a later phase)
 *   - Fetching download counts or dependents (used by the scorer in Phase 2)
 *   - Caching responses across ingestion runs
 *
 * ADR: docs/adr/0003-npm-ecosystem-first.md
 */

import type { FetchRetryOptions } from "./fetch-retry.js";
import {
  RegistryFetcher,
  type FetchOneResult,
  type ParsedRegistryResponse,
} from "./registry-base.js";
import { parseNpmRepositoryField } from "./source-repo.js";

// Re-export for callers that import from this file's path. The shared
// `PackageMetadata` lives in registry-base.ts; npm was its original
// home and the cli / app paths still import it from here.
export type {
  PackageMetadata,
  RegistryFetchResult as NpmRegistryFetchResult,
} from "./registry-base.js";

const NPM_REGISTRY_BASE = "https://registry.npmjs.org";
const DEFAULT_CONCURRENCY = 10;

interface NpmPackageLatest {
  version?: string;
  deprecated?: string;
  /** String or {type, url} — shape unwrapped by parseNpmRepositoryField(). */
  repository?: unknown;
  [key: string]: unknown;
}

export class NpmRegistryFetcher extends RegistryFetcher {
  constructor(
    registryBase: string = NPM_REGISTRY_BASE,
    concurrency: number = DEFAULT_CONCURRENCY,
    fetchRetryOptions: FetchRetryOptions = {},
  ) {
    super(
      {
        registryBase: NPM_REGISTRY_BASE,
        defaultConcurrency: DEFAULT_CONCURRENCY,
        registryLabel: "npm registry",
        versionFieldName: "version",
      },
      registryBase,
      concurrency,
      fetchRetryOptions,
    );
  }

  protected buildPackageUrl(packageName: string): string {
    return `${this.registryBase}/${encodeURIComponent(packageName)}/latest`;
  }

  protected mapResponse(packageName: string, parsed: ParsedRegistryResponse): FetchOneResult {
    const pkg = parsed.body as NpmPackageLatest;
    const sourceRepo = parseNpmRepositoryField(pkg.repository);

    const latestVersion =
      typeof pkg.version === "string" && pkg.version.trim() !== "" ? pkg.version.trim() : null;

    if (latestVersion === null) {
      // Not a hard failure — the package exists but has no version field.
      // repository (and therefore sourceRepo) is independent of version,
      // so it's still resolved here rather than discarded.
      return {
        packageName,
        latestVersion: null,
        isDeprecated: false,
        deprecationNote: null,
        sourceRepo,
        warning: this.noVersionWarning(packageName),
      };
    }

    // "deprecated" is either a non-empty string message or absent entirely.
    const deprecationNote =
      typeof pkg.deprecated === "string" && pkg.deprecated.trim() !== ""
        ? pkg.deprecated.trim()
        : null;

    return {
      packageName,
      latestVersion,
      isDeprecated: deprecationNote !== null,
      deprecationNote,
      sourceRepo,
      warning: undefined,
    };
  }
}
