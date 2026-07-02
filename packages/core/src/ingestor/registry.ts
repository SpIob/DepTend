/**
 * npm Registry Metadata Fetcher
 *
 * For each parsed dependency, fetches the `/latest` dist-tag from the npm
 * registry to populate two fields on the `dependencies` table:
 *
 *   - latestVersion   — the current published version (e.g. "4.18.1")
 *   - isDeprecated    — true when the package maintainer has marked it
 *   - deprecationNote — the deprecation message string, if present
 *
 * API used: https://registry.npmjs.org/<package>/latest
 * No authentication required for public packages.
 * No new runtime dependencies — uses the global fetch API (Node 18+).
 *
 * Fetching strategy:
 *   Requests are made concurrently but with a configurable concurrency
 *   limit (default: 10) to avoid hammering the registry. The npm registry
 *   enforces a rate limit of ~100 requests/min for unauthenticated clients;
 *   10 concurrent requests with no artificial delay is well within that
 *   budget for any real-world package.json at MVP scale (≤ 3 repos,
 *   each unlikely to exceed 200 unique packages).
 *
 * Phase 1 scope — intentionally out of scope:
 *   - Resolving version specs to concrete versions (requires lock file or
 *     full version list fetch — deferred to a later phase)
 *   - Fetching download counts or dependents (used by the scorer in Phase 2)
 *   - Caching responses across ingestion runs
 *
 * ADR: docs/adr/0003-npm-ecosystem-first.md
 */

import type { ParsedDependency } from "./interface.js";

// ---------------------------------------------------------------------------
// npm registry API response shape (fields we care about only)
// ---------------------------------------------------------------------------

interface NpmPackageLatest {
  version?: string;
  deprecated?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/** Metadata for a single package fetched from the npm registry. */
export interface PackageMetadata {
  packageName: string;
  /** Latest published version, or null if the registry returned no version. */
  latestVersion: string | null;
  /** True when the package has a deprecation notice. */
  isDeprecated: boolean;
  /** The deprecation message, or null when not deprecated. */
  deprecationNote: string | null;
}

export interface NpmRegistryFetchResult {
  /** Metadata keyed by package name. */
  metadata: Map<string, PackageMetadata>;
  /** Data-quality warnings to surface in the UI. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// NpmRegistryFetcher
// ---------------------------------------------------------------------------

const NPM_REGISTRY_BASE = "https://registry.npmjs.org";
const DEFAULT_CONCURRENCY = 10;

export class NpmRegistryFetcher {
  private readonly registryBase: string;
  private readonly concurrency: number;

  constructor(registryBase = NPM_REGISTRY_BASE, concurrency = DEFAULT_CONCURRENCY) {
    this.registryBase = registryBase.replace(/\/$/, "");
    this.concurrency = concurrency;
  }

  /**
   * Fetch latest version and deprecation metadata for all provided
   * dependencies. Deduplicates by package name before fetching.
   *
   * Never throws — individual package failures are recorded as warnings
   * and produce a partial-metadata entry so the pipeline can continue.
   */
  async fetchMetadata(dependencies: ParsedDependency[]): Promise<NpmRegistryFetchResult> {
    const warnings: string[] = [];

    if (dependencies.length === 0) {
      return { metadata: new Map(), warnings };
    }

    // Deduplicate — multiple dep_type entries for the same package_name
    // need only one registry lookup.
    const uniquePackages = [...new Set(dependencies.map((d) => d.package_name))];

    // Run with bounded concurrency to avoid overwhelming the registry.
    const results = await this.fetchWithConcurrencyLimit(uniquePackages, this.concurrency);

    const metadata = new Map<string, PackageMetadata>();

    for (const result of results) {
      if (result.warning !== undefined) {
        warnings.push(result.warning);
      }
      metadata.set(result.packageName, {
        packageName: result.packageName,
        latestVersion: result.latestVersion,
        isDeprecated: result.isDeprecated,
        deprecationNote: result.deprecationNote,
      });
    }

    return { metadata, warnings };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Run fetchOne for each package name with at most `limit` in-flight at once.
   */
  private async fetchWithConcurrencyLimit(
    packageNames: string[],
    limit: number,
  ): Promise<FetchOneResult[]> {
    const results: FetchOneResult[] = [];
    let index = 0;

    async function worker(fetcher: NpmRegistryFetcher): Promise<void> {
      while (index < packageNames.length) {
        const current = index++;
        const name = packageNames[current];
        if (name === undefined) continue;
        results[current] = await fetcher.fetchOne(name);
      }
    }

    const workers = Array.from({ length: Math.min(limit, packageNames.length) }, () =>
      worker(this),
    );
    await Promise.all(workers);

    return results;
  }

  /**
   * Fetch metadata for a single package name.
   * Returns a partial result with warnings on any failure — never throws.
   */
  private async fetchOne(packageName: string): Promise<FetchOneResult> {
    const url = `${this.registryBase}/${encodeURIComponent(packageName)}/latest`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      return failedResult(
        packageName,
        `Network error fetching npm metadata for "${packageName}": ${String(err)}`,
      );
    }

    if (response.status === 404) {
      return failedResult(
        packageName,
        `Package "${packageName}" not found in the npm registry (404). ` +
          `It may be unpublished, private, or the name may be incorrect.`,
      );
    }

    if (!response.ok) {
      return failedResult(
        packageName,
        `Unexpected HTTP ${String(response.status)} fetching npm metadata for "${packageName}".`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      return failedResult(
        packageName,
        `Failed to parse npm registry response for "${packageName}": ${String(err)}`,
      );
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return failedResult(
        packageName,
        `npm registry returned an unexpected response shape for "${packageName}".`,
      );
    }

    const pkg = body as NpmPackageLatest;

    const latestVersion =
      typeof pkg.version === "string" && pkg.version.trim() !== "" ? pkg.version.trim() : null;

    if (latestVersion === null) {
      // Not a hard failure — the package exists but has no version field.
      return {
        packageName,
        latestVersion: null,
        isDeprecated: false,
        deprecationNote: null,
        warning:
          `npm registry response for "${packageName}" has no version field. ` +
          `Latest version will be recorded as unknown.`,
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
      warning: undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface FetchOneResult {
  packageName: string;
  latestVersion: string | null;
  isDeprecated: boolean;
  deprecationNote: string | null;
  /** Set when a non-fatal data-quality issue occurred. */
  warning: string | undefined;
}

function failedResult(packageName: string, warning: string): FetchOneResult {
  return {
    packageName,
    latestVersion: null,
    isDeprecated: false,
    deprecationNote: null,
    warning,
  };
}
