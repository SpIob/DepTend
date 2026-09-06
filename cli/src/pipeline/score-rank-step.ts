/**
 * Step 4: Score candidates, generate copy, prefetch effort signals, and rank.
 *
 * Combines:
 *   - Building in-memory rows (dependencies, advisories, candidate pairs)
 *   - Prefetching effort signals (breaking changes, downstream dependents)
 *   - Scoring with computeMissionScore + generating copy with generateMissionCopy
 *   - Ranking with rankMissions
 *
 * Mirrors writer.ts's Step 5/6 wiring exactly, minus the transaction concern.
 */

import {
  buildSignalKey,
  prefetchEffortSignals,
  type EffortSignalRequest,
  type EffortSignals,
} from "@deptend/core/ingestor/changelog-signals.js";
import {
  computeMissionScore,
  extractVersionFloor,
  type MissionScoringContext,
} from "@deptend/core/scorer/mission-scorer.js";
import { generateMissionCopy } from "@deptend/core/scorer/mission-copy.js";
import { rankMissions, type RankableMission } from "@deptend/core/scorer/ranking.js";
import type { AdvisorySource, Ecosystem, Repo } from "@deptend/core/db/schema.js";
import type { PackageMetadata, RegistryFetchResult } from "@deptend/core/ingestor/registry-base.js";
import type { OsvFetchResult } from "@deptend/core/ingestor/osv.js";
import type { IngestorResult } from "@deptend/core/pipeline/ecosystem-detection.js";
import {
  buildAdvisories,
  buildCandidatePairs,
  buildDependencies,
  type CandidatePair,
} from "../build-rows.js";
import type { AnalyzedMission } from "../types.js";

export interface ScoreRankStepInput {
  repo: Repo;
  ingestorResult: IngestorResult;
  osvResult: OsvFetchResult;
  registryResult: RegistryFetchResult;
  sourceRepoByPackage: Map<string, PackageMetadata["sourceRepo"] | null>;
  githubToken: string | null;
}

export interface ScoreRankStepOutput {
  missions: AnalyzedMission[];
  warnings: string[];
  dependenciesScanned: number;
  ecosystem: Ecosystem;
  lockFilePresent: boolean;
}

function advisoryUrl(source: AdvisorySource, osvId: string): string {
  return source === "ghsa"
    ? `https://github.com/advisories/${osvId}`
    : `https://osv.dev/vulnerability/${osvId}`;
}

function stripRankingFields(m: AnalyzedMission & RankableMission): AnalyzedMission {
  const { tie_break: _tie_break, score: _score, ...mission } = m;
  return mission;
}

async function prefetchEffortSignalsForCandidates(
  candidates: CandidatePair[],
  sourceRepoByPackage: Map<string, PackageMetadata["sourceRepo"]>,
  githubToken: string | null,
): Promise<Map<string, EffortSignals>> {
  const requests: EffortSignalRequest[] = candidates.map(({ dependency, advisory }) => {
    const targetVersion = advisory.fixedVersion ?? dependency.latestVersion;
    return {
      key: buildSignalKey(dependency.id, targetVersion),
      sourceRepo: sourceRepoByPackage.get(dependency.packageName) ?? null,
      ecosystem: dependency.ecosystem,
      currentFloor: extractVersionFloor(dependency.ecosystem, dependency.versionSpec),
      targetVersion,
    };
  });

  return prefetchEffortSignals(requests, githubToken);
}

export async function runScoreRankStep(input: ScoreRankStepInput): Promise<ScoreRankStepOutput> {
  const warnings: string[] = [];
  const { repo, ingestorResult, osvResult, registryResult, sourceRepoByPackage, githubToken } =
    input;

  warnings.push(...osvResult.warnings);
  warnings.push(...registryResult.warnings);

  // 5. Fabricate in-memory rows in the shape computeMissionScore expects
  const dependencies = buildDependencies(repo.id, ingestorResult, registryResult);
  const advisoriesByOsvId = buildAdvisories(osvResult);
  const candidates = buildCandidatePairs(
    dependencies,
    advisoriesByOsvId,
    osvResult.packageAdvisoryMap,
  );

  // ADR 0029, Step 6: prefetch before scoring, not inside it — same
  // reasoning as writer.ts's Step 5 (keeps the per-candidate scoring loop
  // below synchronous), even though there's no DB transaction here to
  // avoid holding open.
  const effortSignalsByKey = await prefetchEffortSignalsForCandidates(
    candidates,
    sourceRepoByPackage,
    githubToken,
  );

  // 6. Score + generate copy for each candidate — same pure functions the
  // web app's MissionWriter calls, completely unmodified.
  const scored: (AnalyzedMission & RankableMission)[] = candidates.map(
    ({ dependency, advisory }) => {
      const targetVersion = advisory.fixedVersion ?? dependency.latestVersion;
      const signals = effortSignalsByKey.get(buildSignalKey(dependency.id, targetVersion));
      // exactOptionalPropertyTypes — see writer.ts's identical comment.
      const ctx: MissionScoringContext = {
        dependency,
        advisory,
        repo,
        ...(signals !== undefined && { effortSignals: signals }),
      };
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
          url: advisoryUrl(advisory.source, advisory.osvId),
        },
        // RankableMission fields — not part of the output shape, stripped
        // before writing JSON. Not a shared `now` — see ADR 0018.
        tie_break: { published_at: advisory.publishedAt, osv_id: advisory.osvId },
        score: { composite_score: score.composite_score, effort_label: score.effort_label },
      };
    },
  );

  // 7. Rank — same rankMissions() the dashboard uses, so ordering is
  // identical to what the same data would produce there (ADR 0017).
  const ranked = rankMissions(scored);

  return {
    missions: ranked.map(stripRankingFields),
    warnings,
    dependenciesScanned: ingestorResult.dependencies.length,
    ecosystem: ingestorResult.ecosystem,
    lockFilePresent: ingestorResult.lock_file_present,
  };
}
