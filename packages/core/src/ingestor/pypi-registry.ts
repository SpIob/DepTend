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
 * resolved from info.project_urls/home_page (ADR 0029, Decision 1). PyPI has
 * no fixed schema for project_urls key names, so this is genuinely
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
 * The fetch / dedup / bounded-concurrency / response-shape-checking shell
 * lives in RegistryFetcher (registry-base.ts); this subclass only owns
 * the PyPI-specific bits: the URL shape, the `info` sub-object
 * unwrapping, the source-repo resolution heuristic, and the override
 * for the 404 message ("on PyPI" not "in the PyPI registry").
 *
 * Known, accepted gap (ADR 0022): PyPI has no package-level "deprecated"
 * flag analogous to npm's. The closest signal, info.yanked, means
 * something narrower — a specific release was pulled, not "don't use
 * this package" — so it's deliberately not used as a proxy here.
 * isDeprecated/deprecationNote are always false/null for every PyPI
 * dependency in Phase 6, documented rather than guessed at.
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

import type { FetchRetryOptions } from "./fetch-retry.js";
import {
  RegistryFetcher,
  type FetchOneResult,
  type ParsedRegistryResponse,
} from "./registry-base.js";
import { parseSourceRepo, type SourceRepoRef } from "./source-repo.js";

export type {
  PackageMetadata,
  RegistryFetchResult as PyPIRegistryFetchResult,
} from "./registry-base.js";

const PYPI_REGISTRY_BASE = "https://pypi.org/pypi";
const DEFAULT_CONCURRENCY = 10;

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

export class PyPIRegistryFetcher extends RegistryFetcher {
  constructor(
    registryBase: string = PYPI_REGISTRY_BASE,
    concurrency: number = DEFAULT_CONCURRENCY,
    fetchRetryOptions: FetchRetryOptions = {},
  ) {
    super(
      {
        registryBase: PYPI_REGISTRY_BASE,
        defaultConcurrency: DEFAULT_CONCURRENCY,
        registryLabel: "PyPI registry",
        versionFieldName: "version",
      },
      registryBase,
      concurrency,
      fetchRetryOptions,
    );
  }

  protected override notFoundMessage(packageName: string): string {
    // PyPI's 404 message used "on PyPI" (idiomatic for the PyPI project
    // index) rather than the base's default "in the <label>" template —
    // preserve the original wording for log-search continuity.
    return (
      `Package "${packageName}" not found on PyPI (404). ` +
      `It may be unpublished, removed, or the name may be incorrect.`
    );
  }

  protected buildPackageUrl(packageName: string): string {
    return `${this.registryBase}/${encodeURIComponent(packageName)}/json`;
  }

  protected mapResponse(packageName: string, parsed: ParsedRegistryResponse): FetchOneResult {
    const project = parsed.body as PyPIProjectJson;
    const info = project.info;

    if (typeof info !== "object" || info === null || Array.isArray(info)) {
      return this.failedResult(
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
        // Always false/null for Phase 6 — see module docstring.
        isDeprecated: false,
        deprecationNote: null,
        sourceRepo,
        warning: this.noVersionWarning(packageName),
      };
    }

    return {
      packageName,
      latestVersion,
      // Always false/null for Phase 6 — see module docstring.
      isDeprecated: false,
      deprecationNote: null,
      sourceRepo,
      warning: undefined,
    };
  }
}
