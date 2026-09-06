/**
 * Ecosystem detection — shared pipeline module
 *
 * Re-exports the detectEcosystem function from the ingestor layer so that
 * both scripts/ingest.js and cli/src/analyze.ts can import from a single
 * public path without depending on internal ingestor module structure.
 *
 * ADR 0022: ordered probing, npm first, then PyPI.
 * ADR 0024: Go added as third probed ecosystem, same router.
 * ADR 0041: parallel probing with AbortController, priority tie-break.
 */

export { detectEcosystem } from "../ingestor/detect.js";
export type { IngestorResult, EcosystemIngestor, ParsedDependency } from "../ingestor/interface.js";
