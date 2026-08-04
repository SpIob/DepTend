/**
 * PyPI Registry Metadata Fetcher
 *
 * For each parsed dependency, fetches project metadata from the PyPI JSON
 * API to populate the same fields NpmRegistryFetcher populates for npm:
 *
 *   - latestVersion   — the current published version (e.g. "3.1.3")
 *   - isDeprecated    — always false for Phase 6 (see below)
 *   - deprecationNote — always null for Phase 6 (see below)
 *
 * ...plus one field NOT persisted to the DB — `sourceRepo`, best-effort
 * resolved from info.project_urls/home_page (ADR 0029, Decision 1). PyPI
 * has no fixed schema for project_urls key names, so this is genuinely
 * best-effort — null more often than npm/Go's own resolution, by design,
 * not a bug. See resolvePyPISourceRepo() below.
 *
 * API used: https://pypi.org/pypi/<project>/json
 * No authentication required for public packages. Confirmed case-insensitive
 * and tolerant of "-"/"_" separator variants (e.g. "typing_extensions" and
 * "typing-extensions" both resolve) — no name normalization needed before
 * the request, unlike PEP 503's stricter canonicalization rules for other
 * contexts.
 * No new runtime dependencies — uses the global fetch API (Node 18+).
 *
 * Fetching strategy:
 *   Same bounded-concurrency approach as NpmRegistryFetcher (default: 10
 *   concurrent requests). PyPI doesn't publish a specific unauthenticated
 *   rate limit for this endpoint the way npm's registry docs do — 10 is
 *   carried over as a conservative default matching npm's own, not a
 *   PyPI-specific documented number. Same per-repo (not per-run) budget
 *   reasoning as registry.ts: scripts/ingest.js processes repos strictly
 *   sequentially, so this never has to account for multiple repos'
 *   registry fetches overlapping.
 *
 * Known, accepted gap (ADR 0022): PyPI has no package-level "deprecated"
 * flag analogous to npm's. The closest signal, info.yanked, means something
 * narrower — a specific release was pulled, not "don't use this package" —
 * so it's deliberately not used as a proxy here. isDeprecated/
 * deprecationNote are always false/null for every PyPI dependency in
 * Phase 6, documented rather than guessed at.
 *
 * Phase 6 scope — intentionally out of scope (mirrors registry.ts's own
 * Phase 1 scope note):
 *   - Resolving version specs to concrete versions (requires lock file or
 *     full version list fetch — deferred to a later phase)
 *   - Fetching download counts or dependents (used by the scorer)
 *   - Caching responses across ingestion runs
 *
 * ADR: docs/adr/0022-phase6-pypi-ecosystem.md
 */

import type { ParsedDependency } from "./interface.js";
import type { PackageMetadata } from "./registry.js";
import { parseSourceRepo, type SourceRepoRef } from "./source-repo.js";

// ---------------------------------------------------------------------------
// PyPI JSON API response shape (fields we care about only)
// ---------------------------------------------------------------------------

interface PyPIProjectJson {
  // Explicitly | null, not just optional — unlike Step 2's TOML case, JSON
  // genuinely allows a key to be present with a null value (e.g. a
  // malformed {"info": null} response), and typeof null === "object" in
  // JS, so the null check below is load-bearing at runtime even though it
  // would look redundant if this type only said `info?: {...}`.
  info?: {
    version?: string;
    /**
     * Free-text-keyed map, e.g. {"Source": "...", "Homepage": "..."} — no
     * fixed key schema; PyPI project owners choose the labels. See
     * resolvePyPISourceRepo() below.
     */
    project_urls?: unknown;
    home_page?: unknown;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface PyPIRegistryFetchResult {
  /** Metadata keyed by package name. */
  metadata: Map<string, PackageMetadata>;
  /** Data-quality warnings to surface in the UI. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Source-repo resolution (ADR 0029) — best-effort, not guaranteed
// ---------------------------------------------------------------------------

/**
 * project_urls keys with no fixed schema — PyPI project owners write their
 * own labels ("Source", "Repository", "Code", "GitHub", "Changelog",
 * "Homepage", ...). Values matching this pattern are tried first, since
 * they're more likely to point at the actual repo than "Homepage" or
 * "Documentation" would. Best-effort heuristic, not a spec — see ADR 0029
 * Decision 1 (PyPI resolution is explicitly best-effort, unlike npm/Go).
 */
const LIKELY_SOURCE_KEY_RE = /source|repository|code|github/i;

/**
 * Resolves a PyPI project's own GitHub repo from info.project_urls (tried
 * first, priority keys before the rest) and falls back to info.home_page.
 * Returns null when nothing present resolves to a github.com URL — a real,
 * expected outcome for a meaningful share of PyPI packages, not a bug.
 */
function resolvePyPISourceRepo(info: {
  project_urls?: unknown;
  home_page?: unknown;
}): SourceRepoRef | null {
  const projectUrls = info.project_urls;
  if (typeof projectUrls === "object" && projectUrls !== null && !Array.isArray(projectUrls)) {
    const entries = Object.entries(projectUrls as Record<string, unknown>);
    const priority = entries.filter(([key]) => LIKELY_SOURCE_KEY_RE.test(key));
    const rest = entries.filter(([key]) => !LIKELY_SOURCE_KEY_RE.test(key));

    for (const [, value] of [...priority, ...rest]) {
      if (typeof value === "string") {
        const resolved = parseSourceRepo(value);
        if (resolved !== null) return resolved;
      }
    }
  }

  if (typeof info.home_page === "string") {
    return parseSourceRepo(info.home_page);
  }

  return null;
}

// ---------------------------------------------------------------------------
// PyPIRegistryFetcher
// ---------------------------------------------------------------------------

const PYPI_REGISTRY_BASE = "https://pypi.org/pypi";
const DEFAULT_CONCURRENCY = 10;

export class PyPIRegistryFetcher {
  private readonly registryBase: string;
  private readonly concurrency: number;

  constructor(registryBase = PYPI_REGISTRY_BASE, concurrency = DEFAULT_CONCURRENCY) {
    this.registryBase = registryBase.replace(/\/$/, "");
    this.concurrency = concurrency;
  }

  /**
   * Fetch latest version metadata for all provided dependencies.
   * Deduplicates by package name before fetching.
   *
   * Never throws — individual package failures are recorded as warnings
   * and produce a partial-metadata entry so the pipeline can continue.
   */
  async fetchMetadata(dependencies: ParsedDependency[]): Promise<PyPIRegistryFetchResult> {
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
        // Always false/null for Phase 6 — see module docstring.
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
   * Run fetchOne for each package name with at most `limit` in-flight at once.
   */
  private async fetchWithConcurrencyLimit(
    packageNames: string[],
    limit: number,
  ): Promise<FetchOneResult[]> {
    const results: FetchOneResult[] = [];
    let index = 0;

    async function worker(fetcher: PyPIRegistryFetcher): Promise<void> {
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
    const url = `${this.registryBase}/${encodeURIComponent(packageName)}/json`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      return failedResult(
        packageName,
        `Network error fetching PyPI metadata for "${packageName}": ${String(err)}`,
      );
    }

    if (response.status === 404) {
      return failedResult(
        packageName,
        `Package "${packageName}" not found on PyPI (404). ` +
          `It may be unpublished, removed, or the name may be incorrect.`,
      );
    }

    if (!response.ok) {
      return failedResult(
        packageName,
        `Unexpected HTTP ${String(response.status)} fetching PyPI metadata for "${packageName}".`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      return failedResult(
        packageName,
        `Failed to parse PyPI registry response for "${packageName}": ${String(err)}`,
      );
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return failedResult(
        packageName,
        `PyPI registry returned an unexpected response shape for "${packageName}".`,
      );
    }

    const project = body as PyPIProjectJson;
    const info = project.info;

    if (typeof info !== "object" || info === null || Array.isArray(info)) {
      return failedResult(
        packageName,
        `PyPI registry response for "${packageName}" is missing an "info" object.`,
      );
    }

    const latestVersion =
      typeof info.version === "string" && info.version.trim() !== "" ? info.version.trim() : null;
    const sourceRepo = resolvePyPISourceRepo(info);

    if (latestVersion === null) {
      // Not a hard failure — the project exists but has no version field.
      // project_urls/home_page (and therefore sourceRepo) are independent
      // of version, so still resolved here rather than discarded.
      return {
        packageName,
        latestVersion: null,
        sourceRepo,
        warning:
          `PyPI registry response for "${packageName}" has no version field. ` +
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

function failedResult(packageName: string, warning: string): FetchOneResult {
  return {
    packageName,
    latestVersion: null,
    sourceRepo: null,
    warning,
  };
}
