/**
 * Step 3 (parallel): Fetch OSV advisories and registry metadata.
 *
 * OSV and registry fetches only need the parsed dependency list and the
 * resolved ecosystem — both already in hand from step 1 — so they run in
 * parallel rather than serially. The two fetches are independent (OSV hits
 * api.osv.dev, registry hits the per-ecosystem metadata API) and both are
 * stateless for the duration of a single call; their results are combined
 * only at the writer.write() call below. Cuts roughly half the per-repo
 * ingestion wall time on a hot run.
 */

import { OsvFetcher } from "@deptend/core/ingestor/osv.js";
import {
  REGISTRY_FETCHERS_BY_ECOSYSTEM,
  type PackageMetadata,
} from "@deptend/core/pipeline/registry-fetchers.js";
import type { IngestorResult } from "@deptend/core/pipeline/ecosystem-detection.js";
import type { OsvFetchResult } from "@deptend/core/ingestor/osv.js";
import type { RegistryFetchResult } from "@deptend/core/ingestor/registry-base.js";
import { buildSourceRepoByPackage } from "@deptend/core/pipeline/source-repo-extraction.js";

export interface FetchParallelStepResult {
  osvResult: OsvFetchResult;
  registryResult: RegistryFetchResult;
  sourceRepoByPackage: Map<string, PackageMetadata["sourceRepo"] | null>;
  ecosystem: IngestorResult["ecosystem"];
}

export async function runFetchParallelStep(
  ingestorResult: IngestorResult,
): Promise<FetchParallelStepResult> {
  const osvFetcher = new OsvFetcher();
  const registryFetcher = REGISTRY_FETCHERS_BY_ECOSYSTEM[ingestorResult.ecosystem];

  const [osvResult, registryResult] = await Promise.all([
    osvFetcher.fetchAdvisories(ingestorResult.dependencies, ingestorResult.ecosystem),
    registryFetcher.fetchMetadata(ingestorResult.dependencies),
  ]);

  // ADR 0029, Step 6: no second registry round trip — sourceRepo was already
  // resolved (best-effort) as part of the fetchMetadata() call above.
  // Uses shared pipeline module.
  const sourceRepoByPackage = buildSourceRepoByPackage(registryResult);

  return {
    osvResult,
    registryResult,
    sourceRepoByPackage,
    ecosystem: ingestorResult.ecosystem,
  };
}
