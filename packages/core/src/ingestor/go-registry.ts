/**
 * Go Module Proxy Registry Metadata Fetcher
 *
 * For each parsed dependency, fetches latest-version metadata from the Go
 * module proxy to populate the same fields NpmRegistryFetcher/
 * PyPIRegistryFetcher populate:
 *
 *   - latestVersion   — the current published version (e.g. "v1.9.0")
 *   - isDeprecated    — always false for Phase 7 (see below)
 *   - deprecationNote — always null for Phase 7 (see below)
 *
 * ...plus one field NOT persisted to the DB — `sourceRepo`, resolved
 * directly from the module path itself (ADR 0029), not from any response
 * field. Go module paths conventionally are a domain + owner + repo (e.g.
 * "github.com/gorilla/mux"), so no registry round trip is even needed for
 * this one — see parseSourceRepo() in source-repo.ts.
 *
 * API used: https://proxy.golang.org/<escaped-module-path>/@latest
 * No authentication required for public modules. No new runtime
 * dependencies — uses the global fetch API (Node 18+), same as
 * registry.ts/pypi-registry.ts.
 *
 * Module-path case-encoding (the one piece with no npm/PyPI precedent):
 *   The proxy protocol (golang.org/x/mod/module's own EscapePath) requires
 *   every uppercase ASCII letter in a module path to be replaced with "!"
 *   followed by its lowercase form before the path is used in a request —
 *   e.g. "github.com/Azure/azure-sdk-for-go" becomes
 *   "github.com/!azure/azure-sdk-for-go". Confirmed against the real
 *   protocol source during ADR 0024's own grounding, not assumed.
 *   encodeGoModulePath() below does only this — it does not otherwise
 *   percent-encode the path, because unlike npm's scoped-package names
 *   (where the whole "@scope/pkg" string is one opaque, percent-encoded
 *   path segment), a Go module path's "/" separators are meaningful,
 *   literal path hierarchy the proxy protocol expects to see as-is.
 *
 * Fetching strategy: same bounded-concurrency approach as
 * NpmRegistryFetcher/PyPIRegistryFetcher (default: 10 concurrent
 * requests). Unlike crates.io (ruled out partly for this reason during
 * ADR 0024's ecosystem comparison), proxy.golang.org publishes no explicit
 * per-second rate limit for this endpoint — 10 is carried over as the same
 * conservative default the other two fetchers already use, not a
 * Go-specific documented number. Same per-repo (not per-run) budget
 * reasoning as registry.ts/pypi-registry.ts: scripts/ingest.js processes
 * repos strictly sequentially, so this never has to account for multiple
 * repos' registry fetches overlapping.
 *
 * Known, accepted gap (ADR 0024, Decision 4): the module proxy's @latest
 * endpoint carries no deprecation signal. Go does support a `// Deprecated:`
 * comment convention on a module's own `module` directive, but reading it
 * would require a second network call per dependency (fetching that
 * dependency's own go.mod via @v/<version>.mod, not just @latest) for a
 * signal this project already has precedent (PyPI, ADR 0022) for skipping.
 * isDeprecated/deprecationNote are always false/null for every Go
 * dependency in Phase 7, documented rather than guessed at.
 *
 * Phase 7 scope — intentionally out of scope (mirrors registry.ts's own
 * Phase 1 scope note):
 *   - Resolving version specs to concrete versions (requires go.sum or a
 *     full @v/list fetch — deferred to a later phase)
 *   - Fetching download counts or dependents (used by the scorer)
 *   - Caching responses across ingestion runs
 *
 * ADR: docs/adr/0024-phase7-go-ecosystem.md
 */

import type { ParsedDependency } from "./interface.js";
import type { PackageMetadata } from "./registry.js";
import { parseSourceRepo, type SourceRepoRef } from "./source-repo.js";

// ---------------------------------------------------------------------------
// Go module proxy @latest response shape (fields we care about only)
// ---------------------------------------------------------------------------

interface GoProxyLatest {
  Version?: string;
  Time?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface GoRegistryFetchResult {
  /** Metadata keyed by module path. */
  metadata: Map<string, PackageMetadata>;
  /** Data-quality warnings to surface in the UI. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Module-path case-encoding
// ---------------------------------------------------------------------------

/**
 * Case-encodes a Go module path for use in a module-proxy request path, per
 * the documented GOPROXY protocol: every uppercase ASCII letter becomes "!"
 * followed by its lowercase form. Everything else (digits, ".", "-", "_",
 * "~", "/", already-lowercase letters) passes through unchanged — in
 * particular, "/" separators are preserved literally, not percent-encoded,
 * since the proxy treats them as real path hierarchy.
 *
 * Exported (not just an internal helper) so it can be unit-tested directly
 * against the protocol's own documented examples, independent of any
 * network mocking.
 */
export function encodeGoModulePath(modulePath: string): string {
  let result = "";
  for (const ch of modulePath) {
    if (ch >= "A" && ch <= "Z") {
      result += "!" + ch.toLowerCase();
    } else {
      result += ch;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// GoRegistryFetcher
// ---------------------------------------------------------------------------

const GO_PROXY_BASE = "https://proxy.golang.org";
const DEFAULT_CONCURRENCY = 10;

export class GoRegistryFetcher {
  private readonly registryBase: string;
  private readonly concurrency: number;

  constructor(registryBase = GO_PROXY_BASE, concurrency = DEFAULT_CONCURRENCY) {
    this.registryBase = registryBase.replace(/\/$/, "");
    this.concurrency = concurrency;
  }

  /**
   * Fetch latest-version metadata for all provided dependencies.
   * Deduplicates by module path before fetching.
   *
   * Never throws — individual module failures are recorded as warnings
   * and produce a partial-metadata entry so the pipeline can continue.
   */
  async fetchMetadata(dependencies: ParsedDependency[]): Promise<GoRegistryFetchResult> {
    const warnings: string[] = [];

    if (dependencies.length === 0) {
      return { metadata: new Map(), warnings };
    }

    // Deduplicate — multiple dep_type entries for the same package_name
    // need only one registry lookup (go.mod only ever produces
    // "production", per ADR 0024, but this stays consistent with
    // registry.ts/pypi-registry.ts's own dedup regardless).
    const uniqueModules = [...new Set(dependencies.map((d) => d.package_name))];

    // Run with bounded concurrency to avoid overwhelming the proxy.
    const results = await this.fetchWithConcurrencyLimit(uniqueModules, this.concurrency);

    const metadata = new Map<string, PackageMetadata>();

    for (const result of results) {
      if (result.warning !== undefined) {
        warnings.push(result.warning);
      }
      metadata.set(result.packageName, {
        packageName: result.packageName,
        latestVersion: result.latestVersion,
        // Always false/null for Phase 7 — see module docstring.
        isDeprecated: false,
        deprecationNote: null,
        sourceRepo: result.sourceRepo,
      });
    }

    return { metadata, warnings };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Run fetchOne for each module path with at most `limit` in-flight at once.
   */
  private async fetchWithConcurrencyLimit(
    packageNames: string[],
    limit: number,
  ): Promise<FetchOneResult[]> {
    const results: FetchOneResult[] = [];
    let index = 0;

    async function worker(fetcher: GoRegistryFetcher): Promise<void> {
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
   * Fetch metadata for a single module path.
   * Returns a partial result with warnings on any failure — never throws.
   */
  private async fetchOne(packageName: string): Promise<FetchOneResult> {
    const url = `${this.registryBase}/${encodeGoModulePath(packageName)}/@latest`;

    // Unlike npm/PyPI, this needs no response data at all — the module
    // path itself typically *is* the repo location (e.g.
    // "github.com/gorilla/mux"). Resolved independent of the fetch below
    // so it's still present even on a network failure or 404.
    const sourceRepo = parseSourceRepo(packageName);

    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      return failedResult(
        packageName,
        `Network error fetching Go module metadata for "${packageName}": ${String(err)}`,
        sourceRepo,
      );
    }

    if (response.status === 404) {
      return failedResult(
        packageName,
        `Module "${packageName}" not found in the Go module proxy (404). ` +
          `It may be unpublished, private, or the module path may be incorrect.`,
        sourceRepo,
      );
    }

    if (!response.ok) {
      return failedResult(
        packageName,
        `Unexpected HTTP ${String(response.status)} fetching Go module metadata for "${packageName}".`,
        sourceRepo,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      return failedResult(
        packageName,
        `Failed to parse Go module proxy response for "${packageName}": ${String(err)}`,
        sourceRepo,
      );
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return failedResult(
        packageName,
        `Go module proxy returned an unexpected response shape for "${packageName}".`,
        sourceRepo,
      );
    }

    const proxyResult = body as GoProxyLatest;

    const latestVersion =
      typeof proxyResult.Version === "string" && proxyResult.Version.trim() !== ""
        ? proxyResult.Version.trim()
        : null;

    if (latestVersion === null) {
      // Not a hard failure — the module exists but the response has no
      // Version field.
      return {
        packageName,
        latestVersion: null,
        sourceRepo,
        warning:
          `Go module proxy response for "${packageName}" has no Version field. ` +
          `Latest version will be recorded as unknown.`,
      };
    }

    return {
      packageName,
      latestVersion,
      sourceRepo,
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
  sourceRepo: SourceRepoRef | null;
  /** Set when a non-fatal data-quality issue occurred. */
  warning: string | undefined;
}

function failedResult(
  packageName: string,
  warning: string,
  sourceRepo: SourceRepoRef | null = null,
): FetchOneResult {
  return {
    packageName,
    latestVersion: null,
    sourceRepo,
    warning,
  };
}
