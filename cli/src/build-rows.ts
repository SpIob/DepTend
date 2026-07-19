/**
 * In-memory row construction
 *
 * The CLI has no database — computeMissionScore() and generateMissionCopy()
 * (packages/core/src/scorer/mission-scorer.ts, mission-copy.ts) both expect
 * real Dependency / Advisory / Repo row shapes (Drizzle's inferred SELECT
 * types), which normally only exist after IngestionWriter has written them.
 *
 * This module fabricates those same shapes in memory instead, mirroring
 * IngestionWriter's field mapping (packages/core/src/ingestor/writer.ts)
 * field-for-field so a CLI run scores identically to what a real ingestion
 * would produce for the same data — just with a random id/timestamp instead
 * of a real DB-assigned one, since nothing here is ever persisted.
 *
 * The candidate-pair logic (which dependency/advisory pairs actually become
 * missions) also mirrors IngestionWriter's dependency_advisories
 * construction — same "any advisory for a package is flagged as potentially
 * affecting" conservative matching (Phase 1 scope, see ADR 0003), just
 * without the intermediate DB round-trip to resolve UUIDs, since in-memory
 * objects can just be referenced directly.
 */

import { randomUUID } from "node:crypto";
import type { Advisory, Dependency, Repo } from "@deptend/core/db/schema.js";
import type { IngestorResult } from "@deptend/core/ingestor/interface.js";
import type { OsvFetchResult } from "@deptend/core/ingestor/osv.js";
import type { NpmRegistryFetchResult } from "@deptend/core/ingestor/registry.js";
import type { GitHubRepoMeta } from "@deptend/core/ingestor/github-meta.js";

/** Builds an in-memory Repo row from GitHub API metadata. */
export function buildRepo(ghMeta: GitHubRepoMeta): Repo {
  const now = new Date();
  return {
    id: randomUUID(),
    // Canonical name from GitHub's API, not the raw --github-url input —
    // handles renamed/redirected repos the same way scripts/ingest.js does.
    githubUrl: `https://github.com/${ghMeta.full_name}`,
    owner: ghMeta.owner.login,
    name: ghMeta.name,
    defaultBranch: ghMeta.default_branch,
    description: ghMeta.description,
    stars: ghMeta.stargazers_count,
    openIssuesCount: ghMeta.open_issues_count,
    topics: ghMeta.topics ?? [],
    homepageUrl: ghMeta.homepage,
    // Not meaningful outside a real ingestion run, but Repo requires a
    // value — "complete" reads sensibly for a report that did complete.
    ingestionStatus: "complete",
    lastIngestedAt: now,
    ingestionError: null,
    // No submitting user in a local CLI run.
    submittedBy: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Builds in-memory Dependency rows, merging npm registry metadata in —
 * mirrors IngestionWriter's upsertDependencies depRows construction.
 */
export function buildDependencies(
  repoId: string,
  ingestorResult: IngestorResult,
  registryResult: NpmRegistryFetchResult,
): Dependency[] {
  const now = new Date();

  return ingestorResult.dependencies.map((dep) => {
    const meta = registryResult.metadata.get(dep.package_name);
    return {
      id: randomUUID(),
      repoId,
      ecosystem: "npm",
      packageName: dep.package_name,
      versionSpec: dep.version_spec,
      // Lock file parsing deferred — same as the real pipeline (ADR 0003).
      resolvedVersion: null,
      depType: dep.dep_type,
      latestVersion: meta?.latestVersion ?? null,
      isDeprecated: meta?.isDeprecated ?? false,
      deprecationNote: meta?.deprecationNote ?? null,
      createdAt: now,
      updatedAt: now,
    };
  });
}

/**
 * Builds in-memory Advisory rows keyed by osv_id — mirrors
 * IngestionWriter's upsertAdvisories, minus the actual DB write.
 */
export function buildAdvisories(osvResult: OsvFetchResult): Map<string, Advisory> {
  const now = new Date();
  const result = new Map<string, Advisory>();

  for (const [osvId, newAdvisory] of osvResult.advisories) {
    // NewAdvisory's DB-defaulted columns (ecosystem, severity, etc.) are
    // typed optional in Drizzle's insert type, even though osv.ts's
    // mapVulnToAdvisory always populates every one of them explicitly at
    // runtime (see osv.ts). A plain spread wouldn't narrow those back to
    // the non-optional Advisory select type, so fields are listed
    // explicitly here instead of trusting the spread's inferred type.
    result.set(osvId, {
      id: randomUUID(),
      osvId: newAdvisory.osvId,
      source: newAdvisory.source,
      ecosystem: newAdvisory.ecosystem ?? "npm",
      packageName: newAdvisory.packageName,
      severity: newAdvisory.severity ?? "unknown",
      cvssScore: newAdvisory.cvssScore ?? null,
      summary: newAdvisory.summary,
      details: newAdvisory.details ?? null,
      affectedVersions: newAdvisory.affectedVersions ?? [],
      fixedVersion: newAdvisory.fixedVersion ?? null,
      publishedAt: newAdvisory.publishedAt ?? null,
      modifiedAt: newAdvisory.modifiedAt ?? null,
      rawData: newAdvisory.rawData ?? {},
      createdAt: now,
      updatedAt: now,
    });
  }

  return result;
}

export interface CandidatePair {
  dependency: Dependency;
  advisory: Advisory;
}

/**
 * Determines which (dependency, advisory) pairs are mission candidates —
 * mirrors IngestionWriter's dependency_advisories construction (Phase 1's
 * conservative "any advisory for a package is flagged as potentially
 * affecting" matching, since precise version-range matching needs a
 * resolved version from a lock file — deferred, ADR 0003).
 *
 * Unlike IngestionWriter, there's no dependencyId/advisoryId UUID
 * round-trip through a DB here — in-memory objects are referenced
 * directly once matched by package name.
 */
export function buildCandidatePairs(
  dependencies: Dependency[],
  advisoriesByOsvId: Map<string, Advisory>,
  packageAdvisoryMap: Map<string, string[]>,
): CandidatePair[] {
  const pairs: CandidatePair[] = [];

  for (const [packageName, osvIds] of packageAdvisoryMap) {
    const affectedDeps = dependencies.filter((d) => d.packageName === packageName);

    for (const dependency of affectedDeps) {
      for (const osvId of osvIds) {
        const advisory = advisoriesByOsvId.get(osvId);
        if (advisory === undefined) continue; // detail fetch failed upstream — already warned about

        pairs.push({ dependency, advisory });
      }
    }
  }

  return pairs;
}
