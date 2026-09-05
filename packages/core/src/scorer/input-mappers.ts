/**
 * Input mappers — map MissionScoringContext onto the scorer input shapes
 *
 * ADR: docs/adr/0007-mission-score-writing.md (mapping),
 *      docs/adr/0029-breaking-change-signals.md (effortSignals),
 *      docs/adr/0032-downstream-dependents.md (downstreamDependents),
 *      docs/adr/0038-lock-file-resolution.md (resolvedVersion)
 */

import type { Dependency, Advisory, Repo } from "../db/schema.js";
import type { ImpactInputs, EffortInputs, EcosystemValueInputs } from "../db/json-types.js";
import type { MissionScoringContext } from "./mission-scorer.js";
import { extractVersionFloor, inferBumpForEcosystem } from "./bump-inference.js";

function daysSince(date: Date | null): number | null {
  if (date === null) {
    return null;
  }
  const ms = Date.now() - date.getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

export function buildImpactInputs(ctx: MissionScoringContext): ImpactInputs {
  const isTransitive = ctx.dependency.depType === "transitive";
  const depType = isTransitive ? "optional" : ctx.dependency.depType;
  return {
    cvss_score: ctx.advisory.cvssScore,
    severity: ctx.advisory.severity,
    is_transitive: isTransitive,
    dep_type: depType,
    days_since_advisory: daysSince(ctx.advisory.publishedAt),
    epss_score: ctx.advisory.epssScore ?? null,
  };
}

export function buildEffortInputs(ctx: MissionScoringContext): EffortInputs {
  const targetVersion = ctx.advisory.fixedVersion ?? ctx.dependency.latestVersion;

  const currentVersion =
    ctx.dependency.resolvedVersion ??
    extractVersionFloor(ctx.dependency.ecosystem, ctx.dependency.versionSpec);

  const semverBump =
    currentVersion === null
      ? "unknown"
      : inferBumpForEcosystem(
          ctx.dependency.ecosystem,
          ctx.dependency.versionSpec,
          targetVersion,
          currentVersion,
        );

  return {
    semver_bump: semverBump,
    has_migration_guide: ctx.effortSignals?.has_migration_guide ?? false,
    breaking_change_signals: ctx.effortSignals?.breaking_change_signals ?? [],
  };
}

export function buildEcosystemValueInputs(ctx: MissionScoringContext): EcosystemValueInputs {
  return {
    repo_stars: ctx.repo.stars,
    open_issues_count: ctx.repo.openIssuesCount,
    downstream_dependents: ctx.downstreamDependents ?? null,
  };
}
