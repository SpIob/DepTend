/**
 * Shared test fixtures for scorer test suites
 *
 * Eliminates duplication across mission-scorer.test.ts and mission-copy.test.ts.
 */

import type { Advisory, Dependency, Repo } from "../db/schema.js";
import type { MissionScoringContext } from "./mission-scorer.js";

export function makeDependency(overrides: Partial<Dependency> = {}): Dependency {
  return {
    id: "dep-1",
    repoId: "repo-1",
    ecosystem: "npm",
    packageName: "left-pad",
    versionSpec: "^1.2.3",
    resolvedVersion: null,
    depType: "production",
    latestVersion: "1.4.0",
    isDeprecated: false,
    deprecationNote: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

export function makeAdvisory(overrides: Partial<Advisory> = {}): Advisory {
  return {
    id: "adv-1",
    osvId: "GHSA-xxxx-xxxx-xxxx",
    source: "osv",
    ecosystem: "npm",
    packageName: "left-pad",
    severity: "high",
    cvssScore: 7.5,
    epssScore: null,
    summary: "A padding function allows prototype pollution.",
    details: null,
    affectedVersions: [],
    fixedVersion: "1.2.4",
    publishedAt: new Date("2026-06-01T00:00:00Z"),
    modifiedAt: null,
    rawData: {},
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

export function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo-1",
    githubUrl: "https://github.com/example/example",
    owner: "example",
    name: "example",
    defaultBranch: "main",
    description: null,
    stars: 1000,
    openIssuesCount: 100,
    topics: [],
    homepageUrl: null,
    ingestionStatus: "complete",
    lastIngestedAt: new Date("2026-07-01T00:00:00Z"),
    ingestionError: null,
    submittedBy: null,
    orgId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

export function makeContext(
  overrides: {
    dependency?: ReturnType<typeof makeDependency>;
    advisory?: ReturnType<typeof makeAdvisory>;
    repo?: ReturnType<typeof makeRepo>;
    effortSignals?: MissionScoringContext["effortSignals"];
    downstreamDependents?: MissionScoringContext["downstreamDependents"];
  } = {},
): MissionScoringContext {
  const base = {
    dependency: makeDependency(),
    advisory: makeAdvisory(),
    repo: makeRepo(),
  };
  const result: MissionScoringContext = { ...base };
  if (overrides.dependency) result.dependency = overrides.dependency;
  if (overrides.advisory) result.advisory = overrides.advisory;
  if (overrides.repo) result.repo = overrides.repo;
  if (overrides.effortSignals !== undefined) result.effortSignals = overrides.effortSignals;
  if (overrides.downstreamDependents !== undefined)
    result.downstreamDependents = overrides.downstreamDependents;
  return result;
}
