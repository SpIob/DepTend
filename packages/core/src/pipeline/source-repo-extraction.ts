/**
 * Source repository extraction — shared pipeline module
 *
 * Extracts the sourceRepo map from registry metadata results, used by
 * both scripts/ingest.js and cli/src/analyze.ts to prefetch effort
 * signals (breaking changes, downstream dependents) before scoring.
 *
 * Mirrors ADR 0029 Step 5/6: no second registry round trip — sourceRepo
 * was already resolved (best-effort) as part of the fetchMetadata() call.
 */

export type { SourceRepoRef } from "../ingestor/source-repo.js";
export type { PackageMetadata } from "../ingestor/registry-base.js";

/**
 * Builds a Map<packageName, sourceRepo> from registry metadata.
 * Used by both the ingestion pipeline and the CLI analyzer to avoid
 * a second registry round trip for source repo resolution.
 *
 * @param registryResult - The result from any registry fetcher's fetchMetadata()
 * @returns Map of package name to its source repo (or null if unresolved)
 */
export function buildSourceRepoByPackage(registryResult: {
  metadata: Map<string, { sourceRepo: import("../ingestor/source-repo.js").SourceRepoRef | null }>;
}): Map<string, import("../ingestor/source-repo.js").SourceRepoRef | null> {
  return new Map(
    [...registryResult.metadata.entries()].map(([packageName, meta]) => [
      packageName,
      meta.sourceRepo,
    ]),
  );
}
