/**
 * Base class for the three ecosystem-specific registry fetchers
 * (registry.ts / pypi-registry.ts / go-registry.ts).
 *
 * The three were originally three near-identical copies of the same shell:
 *   - construct with a base URL + concurrency + fetch retry options
 *   - dedup a ParsedDependency[] by package name
 *   - fetch each one with bounded concurrency (runBounded)
 *   - on each fetch: try fetchWithRetry, check 404 / !ok / parse,
 *     then hand the parsed body to a per-ecosystem mapper
 *   - on any per-package failure: append a warning, still produce a
 *     partial PackageMetadata row so the pipeline can continue
 *
 * This base owns the common shell. Each subclass supplies:
 *   - a registry label (for warning messages — "npm", "PyPI", "Go module")
 *   - the URL builder for one package name
 *   - the body-to-`FetchOneResult` mapper
 *   - an optional pre-resolved source repo (Go computes it from the
 *     module path before the fetch, since the path itself IS the repo)
 *
 * Same {kind: fail, warning} shape the three originally used, so
 * the per-fetcher test suites' substring assertions on warning text
 * still match — labels and URL shapes differ but the message templates
 * are preserved.
 */

import type { ParsedDependency } from "./interface.js";
import { fetchWithRetry, type FetchRetryOptions } from "./fetch-retry.js";
import { runBounded } from "./concurrency.js";
import type { SourceRepoRef } from "./source-repo.js";

export interface PackageMetadata {
  packageName: string;
  /** Latest published version, or null if the registry returned no version. */
  latestVersion: string | null;
  /** True when the package has a deprecation notice. */
  isDeprecated: boolean;
  /** The deprecation message, or null when not deprecated. */
  deprecationNote: string | null;
  /**
   * The package's own GitHub repo, resolved from registry metadata — null
   * when the registry lookup failed, the field was absent, or it pointed
   * somewhere other than github.com. Used by changelog-signals.ts (ADR
   * 0029) to fetch that repo's own release notes, not this repo's.
   */
  sourceRepo: SourceRepoRef | null;
}

export interface RegistryFetchResult {
  metadata: Map<string, PackageMetadata>;
  warnings: string[];
}

/**
 * Per-package result produced by one fetchOne() call. The fetchers
 * always return one of these — even on failure — so the bounded-concurrency
 * loop in fetchMetadata() can keep going without aborting on the first
 * error.
 */
export interface FetchOneResult {
  packageName: string;
  latestVersion: string | null;
  isDeprecated: boolean;
  deprecationNote: string | null;
  sourceRepo: SourceRepoRef | null;
  /** Set when a non-fatal data-quality issue occurred. */
  warning: string | undefined;
}

/** The per-package mapper's input. */
export interface ParsedRegistryResponse {
  body: unknown;
  /** Optional pre-resolved source repo (Go pre-computes from the module path). */
  preResolvedSourceRepo: SourceRepoRef | null;
}

export interface SubclassOptions {
  /** Default registry base URL. */
  registryBase: string;
  /** Default concurrency. Each subclass picks a sensible value. */
  defaultConcurrency: number;
  /** Used in warning messages, e.g. "npm registry", "PyPI registry", "Go module proxy". */
  registryLabel: string;
  /**
   * Field name on the parsed response body that holds the version
   * string. Lowercase ("version") for npm + PyPI, capitalized
   * ("Version") for Go's module proxy — Go's wire format uses
   * PascalCase, the other two use JSON's typical camelCase.
   */
  versionFieldName: "version" | "Version";
}

export abstract class RegistryFetcher {
  protected readonly registryBase: string;
  private readonly concurrency: number;
  private readonly fetchRetryOptions: FetchRetryOptions;
  private readonly registryLabel: string;
  private readonly versionFieldName: "version" | "Version";

  protected constructor(
    options: SubclassOptions,
    registryBase: string = options.registryBase,
    concurrency: number = options.defaultConcurrency,
    fetchRetryOptions: FetchRetryOptions = {},
  ) {
    this.registryBase = registryBase.replace(/\/$/, "");
    this.concurrency = concurrency;
    this.fetchRetryOptions = fetchRetryOptions;
    this.registryLabel = options.registryLabel;
    this.versionFieldName = options.versionFieldName;
  }

  /**
   * Fetch latest version and deprecation metadata for all provided
   * dependencies. Deduplicates by package name before fetching.
   *
   * Never throws — individual package failures are recorded as warnings
   * and produce a partial-metadata entry so the pipeline can continue.
   */
  async fetchMetadata(dependencies: ParsedDependency[]): Promise<RegistryFetchResult> {
    const warnings: string[] = [];

    if (dependencies.length === 0) {
      return { metadata: new Map(), warnings };
    }

    // Deduplicate — multiple dep_type entries for the same package_name
    // need only one registry lookup.
    const uniquePackages = [...new Set(dependencies.map((d) => d.package_name))];

    const results = await runBounded(uniquePackages, this.concurrency, (name) =>
      this.fetchOne(name),
    );

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
        sourceRepo: result.sourceRepo,
      });
    }

    return { metadata, warnings };
  }

  // ---------------------------------------------------------------------------
  // Per-ecosystem hooks
  // ---------------------------------------------------------------------------

  /** Build the URL for one package name. */
  protected abstract buildPackageUrl(packageName: string): string;

  /**
   * Pre-resolve source repo from the package name itself, before the
   * fetch. Default: nothing (npm/PyPI derive it from the response). Go
   * overrides to compute it from the module path.
   */
  protected preResolveSourceRepo(_packageName: string): SourceRepoRef | null {
    return null;
  }

  /**
   * Map a parsed response body to a per-package result. Implementations
   * are responsible for shape validation, version extraction, deprecation
   * extraction, and source-repo extraction (the response-derived side).
   * On a non-fatal data-quality issue, return a FetchOneResult with
   * `warning` set and the partially-extracted fields populated — never
   * throw.
   */
  protected abstract mapResponse(
    packageName: string,
    parsed: ParsedRegistryResponse,
    warnings: string[],
  ): FetchOneResult;

  // ---------------------------------------------------------------------------
  // Common shell
  // ---------------------------------------------------------------------------

  /**
   * Fetch metadata for a single package name.
   * Returns a partial result with warnings on any failure — never throws.
   */
  private async fetchOne(packageName: string): Promise<FetchOneResult> {
    const url = this.buildPackageUrl(packageName);
    const preResolvedSourceRepo = this.preResolveSourceRepo(packageName);

    let response: Response;
    try {
      response = await fetchWithRetry(url, undefined, this.fetchRetryOptions);
    } catch (err) {
      return this.failedResult(
        packageName,
        `Network error fetching ${this.registryLabel} metadata for "${packageName}": ${String(err)}`,
        preResolvedSourceRepo,
      );
    }

    if (response.status === 404) {
      return this.failedResult(
        packageName,
        this.notFoundMessage(packageName),
        preResolvedSourceRepo,
      );
    }

    if (!response.ok) {
      return this.failedResult(
        packageName,
        `Unexpected HTTP ${String(response.status)} fetching ${this.registryLabel} metadata for "${packageName}".`,
        preResolvedSourceRepo,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      return this.failedResult(
        packageName,
        `Failed to parse ${this.registryLabel} response for "${packageName}": ${String(err)}`,
        preResolvedSourceRepo,
      );
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return this.failedResult(
        packageName,
        `${this.registryLabel} returned an unexpected response shape for "${packageName}".`,
        preResolvedSourceRepo,
      );
    }

    return this.mapResponse(packageName, { body, preResolvedSourceRepo }, []);
  }

  /** Per-ecosystem 404 message. Subclasses can override. */
  protected notFoundMessage(packageName: string): string {
    return (
      `Package "${packageName}" not found in the ${this.registryLabel} (404). ` +
      `It may be unpublished, private, or the name may be incorrect.`
    );
  }

  /** Helper used by both the shell and by subclasses' mapResponse. */
  protected failedResult(
    packageName: string,
    warning: string,
    sourceRepo: SourceRepoRef | null = null,
  ): FetchOneResult {
    return {
      packageName,
      latestVersion: null,
      isDeprecated: false,
      deprecationNote: null,
      sourceRepo,
      warning,
    };
  }

  /** Common "no version" warning template used by all three mapResponse impls. */
  protected noVersionWarning(packageName: string): string {
    return (
      `${this.registryLabel} response for "${packageName}" has no ${this.versionFieldName} field. ` +
      `Latest version will be recorded as unknown.`
    );
  }
}
