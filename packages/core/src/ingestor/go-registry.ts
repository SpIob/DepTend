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
 * The fetch / dedup / bounded-concurrency / response-shape-checking shell
 * lives in RegistryFetcher (registry-base.ts); this subclass only owns
 * the Go-specific bits: the case-encoded URL, the pre-resolved source
 * repo (the module path IS the repo), the "Version" (capital V) field
 * name on the proxy response, and the override for the 404 message
 * ("not found in the Go module proxy" rather than the base's default).
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

import type { FetchRetryOptions } from "./fetch-retry.js";
import {
  RegistryFetcher,
  type FetchOneResult,
  type ParsedRegistryResponse,
} from "./registry-base.js";
import { parseSourceRepo, type SourceRepoRef } from "./source-repo.js";

export type {
  PackageMetadata,
  RegistryFetchResult as GoRegistryFetchResult,
} from "./registry-base.js";

const GO_PROXY_BASE = "https://proxy.golang.org";
const DEFAULT_CONCURRENCY = 10;

interface GoProxyLatest {
  Version?: string;
  Time?: string;
  [key: string]: unknown;
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

export class GoRegistryFetcher extends RegistryFetcher {
  constructor(
    registryBase: string = GO_PROXY_BASE,
    concurrency: number = DEFAULT_CONCURRENCY,
    fetchRetryOptions: FetchRetryOptions = {},
  ) {
    super(
      {
        registryBase: GO_PROXY_BASE,
        defaultConcurrency: DEFAULT_CONCURRENCY,
        registryLabel: "Go module proxy",
        versionFieldName: "Version",
      },
      registryBase,
      concurrency,
      fetchRetryOptions,
    );
  }

  protected override notFoundMessage(packageName: string): string {
    return (
      `Module "${packageName}" not found in the Go module proxy (404). ` +
      `It may be unpublished, private, or the module path may be incorrect.`
    );
  }

  /**
   * Go module paths conventionally ARE the repo location (e.g.
   * "github.com/gorilla/mux"). Resolve once up front so the result
   * is still present on 404 / network failure / parse error, not
   * just on the happy path.
   */
  protected override preResolveSourceRepo(packageName: string): SourceRepoRef | null {
    return parseSourceRepo(packageName);
  }

  protected buildPackageUrl(packageName: string): string {
    return `${this.registryBase}/${encodeGoModulePath(packageName)}/@latest`;
  }

  protected mapResponse(packageName: string, parsed: ParsedRegistryResponse): FetchOneResult {
    const proxyResult = parsed.body as GoProxyLatest;
    const sourceRepo = parsed.preResolvedSourceRepo;

    const latestVersion =
      typeof proxyResult.Version === "string" && proxyResult.Version.trim() !== ""
        ? proxyResult.Version.trim()
        : null;

    if (latestVersion === null) {
      // Not a hard failure — the module exists but the response has no
      // Version field. sourceRepo is independent (resolved from the
      // module path itself) so still present.
      return {
        packageName,
        latestVersion: null,
        isDeprecated: false,
        deprecationNote: null,
        sourceRepo,
        warning: this.noVersionWarning(packageName),
      };
    }

    return {
      packageName,
      latestVersion,
      isDeprecated: false,
      deprecationNote: null,
      sourceRepo,
      warning: undefined,
    };
  }
}
