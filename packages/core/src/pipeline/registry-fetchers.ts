/**
 * Registry fetchers — shared pipeline module
 *
 * Exports the three ecosystem-specific registry fetcher classes and a
 * pre-built map keyed by Ecosystem value. Both scripts/ingest.js and
 * cli/src/analyze.ts import this instead of constructing their own copies.
 *
 * The map lookup fails loudly (undefined) for a missing ecosystem rather
 * than silently falling through to a wrong fetcher — same exhaustiveness
 * guarantee osv.ts's OSV_ECOSYSTEM_NAMES already provides.
 */

export { NpmRegistryFetcher, type NpmRegistryFetchResult } from "../ingestor/registry.js";

export { PyPIRegistryFetcher, type PyPIRegistryFetchResult } from "../ingestor/pypi-registry.js";

export { GoRegistryFetcher, type GoRegistryFetchResult } from "../ingestor/go-registry.js";

export type { PackageMetadata, RegistryFetchResult } from "../ingestor/registry-base.js";

import type { Ecosystem } from "../db/schema.js";
import type { RegistryFetcher } from "../ingestor/registry-base.js";
import { NpmRegistryFetcher } from "../ingestor/registry.js";
import { PyPIRegistryFetcher } from "../ingestor/pypi-registry.js";
import { GoRegistryFetcher } from "../ingestor/go-registry.js";

/**
 * Common shape all three registry fetchers already share structurally —
 * used only to type REGISTRY_FETCHERS_BY_ECOSYSTEM below, not exported.
 */
type RegistryFetcherLike = RegistryFetcher;

/**
 * Which registry fetcher applies for each detected ecosystem.
 * Record<Ecosystem, ...>, not a ternary — a future ecosystem missing an
 * entry here is a compile error, not a silent npm-fetcher fall-through.
 * (Found as a real pre-existing gap during ADR 0024's own grounding —
 * this was a `ecosystem === "pypi" ? new PyPIRegistryFetcher() : new
 * NpmRegistryFetcher()` ternary before Phase 7, the CLI-side mirror of
 * the identical gap fixed in scripts/ingest.js.)
 */
export const REGISTRY_FETCHERS_BY_ECOSYSTEM: Record<Ecosystem, RegistryFetcherLike> = {
  npm: new NpmRegistryFetcher(),
  pypi: new PyPIRegistryFetcher(),
  go: new GoRegistryFetcher(),
};
