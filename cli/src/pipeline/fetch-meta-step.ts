/**
 * Step 2: Fetch GitHub repo metadata (stars, issues, etc.) — required for
 * ecosystem_value scoring.
 */

import { fetchGitHubRepoMeta } from "@deptend/core/ingestor/github-meta.js";
import { buildRepo } from "../build-rows.js";
import type { Repo } from "@deptend/core/db/schema.js";

export interface FetchMetaStepResult {
  repo: Repo;
}

export async function runFetchMetaStep(
  githubOwner: string,
  githubName: string,
  githubToken: string | null,
): Promise<FetchMetaStepResult> {
  const ghMeta = await fetchGitHubRepoMeta(githubOwner, githubName, githubToken);
  const repo = buildRepo(ghMeta);
  return { repo };
}
