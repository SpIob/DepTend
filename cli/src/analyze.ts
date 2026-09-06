/**
 * CLI analysis pipeline orchestrator
 *
 * Runs the same dependency-parsing -> OSV lookup -> registry lookup ->
 * scoring pipeline as scripts/ingest.js, entirely in-memory against a local
 * repo path — no DB writes, no IngestionWriter/MissionWriter. Reuses
 * packages/core's pure scoring functions (computeMissionScore,
 * generateMissionCopy, rankMissions) directly and unmodified; the only new
 * code is build-rows.ts, which fabricates the in-memory Repo/Dependency/
 * Advisory objects those functions expect.
 *
 * Phase 4 scope (per project plan): npx-runnable CLI produces the same
 * ranked mission list locally from a repo path; JSON export works.
 *
 * Phase 6 (ADR 0022): ecosystem is no longer assumed to be npm — detected
 * via ordered probing (detectEcosystem, same router scripts/ingest.js uses)
 * so a repo path is analyzed identically regardless of which pipeline
 * touches it.
 * Phase 7 (ADR 0024): Go added as a third probed ecosystem — same router,
 * same reasoning.
 * ADR 0029 (Step 6): mirrors writer.ts's Step 5 wiring exactly, minus the
 * transaction concern that doesn't apply here — sourceRepoByPackage comes
 * from the same registryResult already fetched at step 4 below (no second
 * registry round trip), and the prefetch happens before the .map() over
 * candidates so that loop can stay synchronous, same reasoning as writer.ts.
 */

import { runDetectStep } from "./pipeline/detect-step.js";
import { runFetchMetaStep } from "./pipeline/fetch-meta-step.js";
import { runFetchParallelStep } from "./pipeline/fetch-parallel-step.js";
import { runScoreRankStep } from "./pipeline/score-rank-step.js";
import type { AnalyzeOptions, AnalyzeResult } from "./types.js";

export async function analyze(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const warnings: string[] = [];

  // 1. Detect ecosystem + parse dependencies from the local repo path.
  const ingestorResult = await runDetectStep(options.repoPath);
  warnings.push(...ingestorResult.warnings);

  // 2. Fetch GitHub repo metadata (stars/issues — required for ecosystem_value)
  const { repo } = await runFetchMetaStep(
    options.githubOwner,
    options.githubName,
    options.githubToken,
  );

  // 3. Fetch OSV advisories and registry metadata in parallel
  const { osvResult, registryResult, sourceRepoByPackage } =
    await runFetchParallelStep(ingestorResult);

  // 4. Score, generate copy, prefetch effort signals, and rank
  const {
    missions,
    warnings: scoreWarnings,
    dependenciesScanned,
    ecosystem,
    lockFilePresent,
  } = await runScoreRankStep({
    repo,
    ingestorResult,
    osvResult,
    registryResult,
    sourceRepoByPackage,
    githubToken: options.githubToken,
  });
  warnings.push(...scoreWarnings);

  return {
    generated_at: new Date().toISOString(),
    repo: {
      github_url: repo.githubUrl,
      owner: repo.owner,
      name: repo.name,
      default_branch: repo.defaultBranch,
      stars: repo.stars,
      open_issues_count: repo.openIssuesCount,
    },
    dependencies_scanned: dependenciesScanned,
    ecosystem,
    lock_file_present: lockFilePresent,
    missions,
    warnings,
  };
}
