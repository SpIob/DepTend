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
 *
 * Phase 6 (ADR 0022): ecosystem is no longer assumed to be npm — detected
 * via ordered probing (detectEcosystem, same router scripts/ingest.js uses)
 * so a repo path is analyzed identically regardless of which pipeline
 * touches it.
 * Phase 7 (ADR 0024): Go added as a third probed ecosystem — same router,
 * same reasoning.
 */

import { LocalNpmIngestor } from "@deptend/core/ingestor/local-npm.js";
import { LocalPyPIIngestor } from "@deptend/core/ingestor/local-pypi.js";
import { LocalGoIngestor } from "@deptend/core/ingestor/local-go.js";
import { detectEcosystem } from "@deptend/core/ingestor/detect.js";
import { OsvFetcher } from "@deptend/core/ingestor/osv.js";
import { NpmRegistryFetcher } from "@deptend/core/ingestor/registry.js";
import { PyPIRegistryFetcher } from "@deptend/core/ingestor/pypi-registry.js";
import { GoRegistryFetcher } from "@deptend/core/ingestor/go-registry.js";
import { fetchGitHubRepoMeta } from "@deptend/core/ingestor/github-meta.js";
import {
  computeMissionScore,
  type MissionScoringContext,
} from "@deptend/core/scorer/mission-scorer.js";
import { generateMissionCopy } from "@deptend/core/scorer/mission-copy.js";
import { rankMissions, type RankableMission } from "@deptend/core/scorer/ranking.js";
import type { Ecosystem } from "@deptend/core/db/schema.js";
import type { ParsedDependency } from "@deptend/core/ingestor/interface.js";
import type { PackageMetadata } from "@deptend/core/ingestor/registry.js";
import {
  buildAdvisories,
  buildCandidatePairs,
  buildDependencies,
  buildRepo,
} from "./build-rows.js";
import type { AnalyzeOptions, AnalyzeResult, AnalyzedMission } from "./types.js";

/**
 * Common shape all three registry fetchers already share structurally —
 * used only to type REGISTRY_FETCHERS_BY_ECOSYSTEM below, not exported.
 */
interface RegistryFetcherLike {
  fetchMetadata(
    dependencies: ParsedDependency[],
  ): Promise<{ metadata: Map<string, PackageMetadata>; warnings: string[] }>;
}

/**
 * Which registry fetcher applies for each detected ecosystem.
 * Record<Ecosystem, ...>, not a ternary — same exhaustiveness guarantee
 * osv.ts's OSV_ECOSYSTEM_NAMES already has; a future ecosystem missing an
 * entry here is a compile error, not a silent npm-fetcher fall-through.
 * (Found as a real pre-existing gap during ADR 0024's own grounding —
 * this was a `ecosystem === "pypi" ? new PyPIRegistryFetcher() : new
 * NpmRegistryFetcher()` ternary before Phase 7, the CLI-side mirror of
 * the identical gap fixed in scripts/ingest.js.)
 */
const REGISTRY_FETCHERS_BY_ECOSYSTEM: Record<Ecosystem, RegistryFetcherLike> = {
  npm: new NpmRegistryFetcher(),
  pypi: new PyPIRegistryFetcher(),
  go: new GoRegistryFetcher(),
};

export async function analyze(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const warnings: string[] = [];

  // 1. Detect ecosystem + parse dependencies from the local repo path.
  // Ordered probing (ADR 0022, extended in ADR 0024): npm first, then
  // PyPI, then Go — matches scripts/ingest.js's own probing order, so a
  // repo detects the same way regardless of which pipeline analyzed it.
  const ingestorResult = await detectEcosystem(
    [new LocalNpmIngestor(), new LocalPyPIIngestor(), new LocalGoIngestor()],
    options.repoPath,
  );
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
  const osvResult = await osvFetcher.fetchAdvisories(
    ingestorResult.dependencies,
    ingestorResult.ecosystem,
  );
  warnings.push(...osvResult.warnings);

  // 4. Fetch registry metadata (latest version, deprecation status) —
  // matching fetcher for whichever ecosystem actually resolved.
  const registryFetcher = REGISTRY_FETCHERS_BY_ECOSYSTEM[ingestorResult.ecosystem];
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
    ecosystem: ingestorResult.ecosystem,
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
