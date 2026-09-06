/**
 * Step 1: Detect ecosystem and parse dependencies from local repo path.
 *
 * Ordered probing (ADR 0022, extended in ADR 0024): npm first, then PyPI,
 * then Go — matches scripts/ingest.js's own probing order, so a repo
 * detects the same way regardless of which pipeline analyzed it.
 */

import { LocalNpmIngestor } from "@deptend/core/ingestor/local-npm.js";
import { LocalPyPIIngestor } from "@deptend/core/ingestor/local-pypi.js";
import { LocalGoIngestor } from "@deptend/core/ingestor/local-go.js";
import {
  detectEcosystem,
  type IngestorResult,
} from "@deptend/core/pipeline/ecosystem-detection.js";

export async function runDetectStep(repoPath: string): Promise<IngestorResult> {
  return detectEcosystem(
    [new LocalNpmIngestor(), new LocalPyPIIngestor(), new LocalGoIngestor()],
    repoPath,
  );
}
