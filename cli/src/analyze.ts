/**
 * CLI analysis pipeline
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
 */

import { LocalNpmIngestor } from "@deptend/core/ingestor/local-npm.js";
import { OsvFetcher } from "@deptend/core/ingestor/osv.js";
import { NpmRegistryFetcher } from "@deptend/core/ingestor/registry.js";
import { fetchGitHubRepoMeta } from "@deptend/core/ingestor/github-meta.js";
import {
  computeMissionScore,
  type MissionScoringContext,
} from "@deptend/core/scorer/mission-scorer.js";
import { generateMissionCopy } from "@deptend/core/scorer/mission-copy.js";
import { rankMissions, type RankableMission } from "@deptend/core/scorer/ranking.js";
import {
  buildAdvisories,
  buildCandidatePairs,
  buildDependencies,
  buildRepo,
} from "./build-rows.js";
import type { AnalyzeOptions, AnalyzeResult, AnalyzedMission } from "./types.js";

export async function analyze(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const warnings: string[] = [];

  // 1. Parse package.json from the local repo path
  const ingestor = new LocalNpmIngestor();
  const ingestorResult = await ingestor.parseDependencies(options.repoPath);
  warnings.push(...ingestorResult.warnings);

  // 2. Fetch GitHub repo metadata (stars/issues — required for ecosystem_value)
  const ghMeta = await fetchGitHubRepoMeta(
    options.githubOwner,
    options.githubName,
    options.githubToken,
  );
  const repo = buildRepo(ghMeta);

  // 3. Fetch OSV advisories for whatever dependencies were found
  const osvFetcher = new OsvFetcher();
  const osvResult = await osvFetcher.fetchAdvisories(ingestorResult.dependencies);
  warnings.push(...osvResult.warnings);

  // 4. Fetch npm registry metadata (latest version, deprecation status)
  const registryFetcher = new NpmRegistryFetcher();
  const registryResult = await registryFetcher.fetchMetadata(ingestorResult.dependencies);
  warnings.push(...registryResult.warnings);

  // 5. Fabricate in-memory rows in the shape computeMissionScore expects
  const dependencies = buildDependencies(repo.id, ingestorResult, registryResult);
  const advisoriesByOsvId = buildAdvisories(osvResult);
  const candidates = buildCandidatePairs(
    dependencies,
    advisoriesByOsvId,
    osvResult.packageAdvisoryMap,
  );

  // 6. Score + generate copy for each candidate — same pure functions the
  // web app's MissionWriter calls, completely unmodified.
  const now = new Date();
  const scored: (AnalyzedMission & RankableMission)[] = candidates.map(
    ({ dependency, advisory }) => {
      const ctx: MissionScoringContext = { dependency, advisory, repo };
      const score = computeMissionScore(ctx);
      const copy = generateMissionCopy(ctx, score);

      return {
        title: copy.title,
        description: copy.description,
        action_hint: copy.action_hint,
        composite_score: score.composite_score,
        impact_score: score.impact_score,
        ecosystem_value_score: score.ecosystem_value_score,
        effort_label: score.effort_label,
        confidence: score.confidence,
        confidence_notes: score.confidence_notes,
        scoring_version: score.scoring_version,
        scoring_inputs: {
          impact: score.impact_inputs,
          effort: score.effort_inputs,
          ecosystem_value: score.ecosystem_value_inputs,
        },
        dependency: {
          package_name: dependency.packageName,
          version_spec: dependency.versionSpec,
          dep_type: dependency.depType,
          latest_version: dependency.latestVersion,
          is_deprecated: dependency.isDeprecated,
        },
        advisory: {
          osv_id: advisory.osvId,
          source: advisory.source,
          severity: advisory.severity,
          cvss_score: advisory.cvssScore,
          fixed_version: advisory.fixedVersion,
          summary: advisory.summary,
          url: `https://osv.dev/vulnerability/${advisory.osvId}`,
        },
        // RankableMission fields — not part of the output shape, stripped
        // before writing JSON (see index.ts). Not a shared `now` — see
        // ADR 0018; that was exactly this bug's CLI-side manifestation.
        tie_break: { published_at: advisory.publishedAt, osv_id: advisory.osvId },
        score: { composite_score: score.composite_score, effort_label: score.effort_label },
      };
    },
  );

  // 7. Rank — same rankMissions() the dashboard uses, so ordering is
  // identical to what the same data would produce there (ADR 0017).
  const ranked = rankMissions(scored);

  return {
    generated_at: now.toISOString(),
    repo: {
      github_url: repo.githubUrl,
      owner: repo.owner,
      name: repo.name,
      default_branch: repo.defaultBranch,
      stars: repo.stars,
      open_issues_count: repo.openIssuesCount,
    },
    dependencies_scanned: ingestorResult.dependencies.length,
    lock_file_present: ingestorResult.lock_file_present,
    missions: ranked.map(stripRankingFields),
    warnings,
  };
}

/** Drops the RankableMission-only fields (tie_break, score) before output. */
function stripRankingFields(m: AnalyzedMission & RankableMission): AnalyzedMission {
  const { tie_break: _tie_break, score: _score, ...mission } = m;
  return mission;
}
