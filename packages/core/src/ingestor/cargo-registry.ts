/**
 * crates.io Registry Metadata Fetcher
 *
 * For each parsed dependency, fetches project metadata from the crates.io
 * API to populate the same fields NpmRegistryFetcher/PyPIRegistryFetcher/
 * GoRegistryFetcher populate:
 *
 *   - latestVersion   — the current published version (crate.max_version)
 *   - isDeprecated    — always false (see below)
 *   - deprecationNote — always null (see below)
 *
 * ...plus one field NOT persisted to the DB — `sourceRepo`, resolved from
 * crate.repository, falling back to crate.repository_url then
 * crate.homepage (all live-confirmed on serde during ADR 0063's grounding;
 * `repository` and `repository_url` coexist in the real response — the
 * plain `repository_url` came back null there, so `repository` is tried
 * first).
 *
 * API used: https://crates.io/api/v1/crates/<name>
 * No authentication required, but a User-Agent header IS required by
 * crates.io's documented policy — requests without one are subject to
 * blocking. The header is attached via RegistryFetcher's request-headers
 * hook (a small, backward-compatible extension added for this fetcher —
 * no other registry needed request headers before).
 *
 * Rate policy (ADR 0063's flagged decision point): crates.io documents a
 * ~1 request/second fair-use policy. This fetcher is constructed with
 * concurrency 1 (the bounded-concurrency shell in RegistryFetcher makes
 * that a one-number change), so a repo with N direct cargo deps pays ~N
 * sequential round-trips; combined with natural fetch latency this
 * best-effort respects the policy. A hard per-request pacer is the
 * documented follow-up if a real repo ever trips a 429. The failure path
 * is fail-soft by the base class's construction: a throttled or failed
 * fetch warns, leaves latestVersion null, and the ingestion writer's
 * erosion guard preserves any previously stored value.
 *
 * Known, accepted gap (ADR 0063, Decision 4): crates.io has no
 * package-level deprecation flag. Yanked is a per-release signal (a
 * specific version was pulled), not "don't use this package" — the same
 * reasoning ADR 0022 used to reject info.yanked as a PyPI deprecation
 * proxy. isDeprecated/deprecationNote are always false/null for every
 * cargo dependency, documented rather than guessed at.
 *
 * Scope — intentionally out of scope (mirrors the other fetchers' notes):
 *   - Resolving version specs to concrete versions (Cargo.lock does that)
 *   - Download counts or dependents (used by the scorer)
 *   - Caching responses across ingestion runs
 *
 * ADR: docs/adr/0063-cargo-ecosystem.md
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
  RegistryFetchResult as CargoRegistryFetchResult,
} from "./registry-base.js";

const CRATES_REGISTRY_BASE = "https://crates.io/api/v1/crates";

/**
 * crates.io blocks requests without a descriptive User-Agent. Identifies
 * the project and points at the deployed site, per their policy's
 * recommendation for contactable identifiers.
 */
const CRATES_USER_AGENT = "DepTend/0.1 (+https://deptend.vercel.app)";

/**
 * Concurrency 1 is the chosen mitigation for crates.io's ~1 req/s
 * fair-use policy — see the module docstring. Exported so the constant
 * is visible at the REGISTRY_FETCHERS_BY_ECOSYSTEM construction site
 * without reading this file.
 */
export const CRATES_CONCURRENCY = 1;

interface CratesCrateJson {
  max_version?: unknown;
  repository?: unknown;
  repository_url?: unknown;
  homepage?: unknown;
  [key: string]: unknown;
}

interface CratesResponseJson {
  crate?: CratesCrateJson | null;
  [key: string]: unknown;
}

export class CratesRegistryFetcher extends RegistryFetcher {
  constructor(
    registryBase: string = CRATES_REGISTRY_BASE,
    concurrency: number = CRATES_CONCURRENCY,
    fetchRetryOptions: FetchRetryOptions = {},
  ) {
    super(
      {
        registryBase: CRATES_REGISTRY_BASE,
        defaultConcurrency: CRATES_CONCURRENCY,
        registryLabel: "crates.io",
        versionFieldName: "version",
      },
      registryBase,
      concurrency,
      fetchRetryOptions,
    );
  }

  protected override notFoundMessage(packageName: string): string {
    return (
      `Crate "${packageName}" not found on crates.io (404). ` +
      `It may be unpublished, removed, or the name may be incorrect.`
    );
  }

  protected override buildRequestHeaders(): Record<string, string> | undefined {
    return { "User-Agent": CRATES_USER_AGENT };
  }

  protected buildPackageUrl(packageName: string): string {
    return `${this.registryBase}/${encodeURIComponent(packageName)}`;
  }

  protected mapResponse(packageName: string, parsed: ParsedRegistryResponse): FetchOneResult {
    const response = parsed.body as CratesResponseJson;
    const crate = response.crate;

    if (typeof crate !== "object" || crate === null || Array.isArray(crate)) {
      return this.failedResult(
        packageName,
        `crates.io response for "${packageName}" is missing a "crate" object.`,
      );
    }

    const latestVersion =
      typeof crate.max_version === "string" && crate.max_version.trim() !== ""
        ? crate.max_version.trim()
        : null;
    const sourceRepo = resolveCratesSourceRepo(crate);

    if (latestVersion === null) {
      // Not a hard failure — the crate exists but has no max_version
      // field. sourceRepo is independent of version, so still resolved.
      return {
        packageName,
        latestVersion: null,
        // Always false/null — crates.io has no package-level deprecation
        // flag; see module docstring (ADR 0063, Decision 4).
        isDeprecated: false,
        deprecationNote: null,
        sourceRepo,
        warning: this.noVersionWarning(packageName),
      };
    }

    return {
      packageName,
      latestVersion,
      // Always false/null — see module docstring.
      isDeprecated: false,
      deprecationNote: null,
      sourceRepo,
      warning: undefined,
    };
  }
}

/**
 * Resolves a crate's own GitHub repo from the response's repository
 * fields. crates.io stores whatever the crate's manifest declared — a
 * non-GitHub URL (or absent field) resolves to null, a real and common
 * outcome, not a bug. Same contract as PyPI's resolvePyPISourceRepo().
 */
function resolveCratesSourceRepo(crate: CratesCrateJson): SourceRepoRef | null {
  const candidates = [crate.repository, crate.repository_url, crate.homepage];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const resolved = parseSourceRepo(candidate);
      if (resolved !== null) return resolved;
    }
  }
  return null;
}
