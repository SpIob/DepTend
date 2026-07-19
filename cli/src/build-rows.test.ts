import { describe, expect, it } from "vitest";
import type { Advisory } from "@deptend/core/db/schema.js";
import type { GitHubRepoMeta } from "@deptend/core/ingestor/github-meta.js";
import type { IngestorResult } from "@deptend/core/ingestor/interface.js";
import type { NpmRegistryFetchResult } from "@deptend/core/ingestor/registry.js";
import type { OsvFetchResult } from "@deptend/core/ingestor/osv.js";
import {
  buildAdvisories,
  buildCandidatePairs,
  buildDependencies,
  buildRepo,
} from "./build-rows.js";

const GH_META: GitHubRepoMeta = {
  full_name: "owner/repo",
  name: "repo",
  owner: { login: "owner" },
  default_branch: "main",
  description: "A test repo",
  stargazers_count: 42,
  open_issues_count: 3,
  topics: ["testing"],
  homepage: null,
};

describe("buildRepo", () => {
  it("maps GitHub metadata onto a Repo shape", () => {
    const repo = buildRepo(GH_META);

    expect(repo.githubUrl).toBe("https://github.com/owner/repo");
    expect(repo.owner).toBe("owner");
    expect(repo.name).toBe("repo");
    expect(repo.defaultBranch).toBe("main");
    expect(repo.stars).toBe(42);
    expect(repo.openIssuesCount).toBe(3);
    expect(repo.submittedBy).toBeNull();
    expect(repo.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("defaults topics to an empty array when GitHub omits them", () => {
    const { topics: _topics, ...ghMetaWithoutTopics } = GH_META;
    const repo = buildRepo(ghMetaWithoutTopics);
    expect(repo.topics).toEqual([]);
  });
});

describe("buildDependencies", () => {
  const ingestorResult: IngestorResult = {
    ecosystem: "npm",
    dependencies: [
      { package_name: "react", version_spec: "^18.0.0", dep_type: "production" },
      { package_name: "vitest", version_spec: "^2.0.0", dep_type: "development" },
    ],
    lock_file_present: true,
    warnings: [],
  };

  it("merges registry metadata into dependency rows", () => {
    const registryResult: NpmRegistryFetchResult = {
      metadata: new Map([
        [
          "react",
          {
            packageName: "react",
            latestVersion: "18.3.1",
            isDeprecated: false,
            deprecationNote: null,
          },
        ],
      ]),
      warnings: [],
    };

    const deps = buildDependencies("repo-1", ingestorResult, registryResult);

    expect(deps).toHaveLength(2);
    const react = deps.find((d) => d.packageName === "react");
    expect(react?.latestVersion).toBe("18.3.1");
    expect(react?.isDeprecated).toBe(false);
    expect(react?.repoId).toBe("repo-1");
    expect(react?.resolvedVersion).toBeNull();

    const vitestDep = deps.find((d) => d.packageName === "vitest");
    expect(vitestDep?.latestVersion).toBeNull(); // no registry metadata for it
    expect(vitestDep?.depType).toBe("development");
  });

  it("returns an empty array when there are no dependencies", () => {
    const deps = buildDependencies(
      "repo-1",
      { ...ingestorResult, dependencies: [] },
      {
        metadata: new Map(),
        warnings: [],
      },
    );
    expect(deps).toEqual([]);
  });
});

describe("buildAdvisories", () => {
  it("adds id/createdAt/updatedAt to each NewAdvisory", () => {
    const osvResult: OsvFetchResult = {
      advisories: new Map([
        [
          "GHSA-xxxx",
          {
            osvId: "GHSA-xxxx",
            source: "ghsa",
            ecosystem: "npm",
            packageName: "lodash",
            severity: "high",
            cvssScore: 7.5,
            summary: "Test advisory",
            details: null,
            affectedVersions: [],
            fixedVersion: "4.17.21",
            publishedAt: null,
            modifiedAt: null,
            rawData: {},
          },
        ],
      ]),
      packageAdvisoryMap: new Map(),
      warnings: [],
    };

    const advisories = buildAdvisories(osvResult);

    expect(advisories.size).toBe(1);
    const advisory = advisories.get("GHSA-xxxx");
    expect(advisory?.osvId).toBe("GHSA-xxxx");
    expect(advisory?.severity).toBe("high");
    expect(advisory?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(advisory?.createdAt).toBeInstanceOf(Date);
  });
});

describe("buildCandidatePairs", () => {
  function makeAdvisory(osvId: string, overrides: Partial<Advisory> = {}): Advisory {
    return {
      id: `advisory-${osvId}`,
      osvId,
      source: "osv",
      ecosystem: "npm",
      packageName: "lodash",
      severity: "high",
      cvssScore: 7.5,
      summary: "Test",
      details: null,
      affectedVersions: [],
      fixedVersion: null,
      publishedAt: null,
      modifiedAt: null,
      rawData: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  it("pairs a dependency with every advisory that affects its package name", () => {
    const dependencies = [
      {
        id: "dep-1",
        repoId: "repo-1",
        ecosystem: "npm" as const,
        packageName: "lodash",
        versionSpec: "^4.0.0",
        resolvedVersion: null,
        depType: "production" as const,
        latestVersion: null,
        isDeprecated: false,
        deprecationNote: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const advisoriesByOsvId = new Map([
      ["GHSA-1", makeAdvisory("GHSA-1")],
      ["GHSA-2", makeAdvisory("GHSA-2")],
    ]);
    const packageAdvisoryMap = new Map([["lodash", ["GHSA-1", "GHSA-2"]]]);

    const pairs = buildCandidatePairs(dependencies, advisoriesByOsvId, packageAdvisoryMap);

    expect(pairs).toHaveLength(2);
    expect(pairs.map((p) => p.advisory.osvId).sort()).toEqual(["GHSA-1", "GHSA-2"]);
    expect(pairs.every((p) => p.dependency.packageName === "lodash")).toBe(true);
  });

  it("pairs a package listed under multiple dep_types with the same advisory separately", () => {
    const dependencies = [
      {
        id: "dep-prod",
        repoId: "repo-1",
        ecosystem: "npm" as const,
        packageName: "lodash",
        versionSpec: "^4.0.0",
        resolvedVersion: null,
        depType: "production" as const,
        latestVersion: null,
        isDeprecated: false,
        deprecationNote: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "dep-dev",
        repoId: "repo-1",
        ecosystem: "npm" as const,
        packageName: "lodash",
        versionSpec: "^4.0.0",
        resolvedVersion: null,
        depType: "development" as const,
        latestVersion: null,
        isDeprecated: false,
        deprecationNote: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const advisoriesByOsvId = new Map([["GHSA-1", makeAdvisory("GHSA-1")]]);
    const packageAdvisoryMap = new Map([["lodash", ["GHSA-1"]]]);

    const pairs = buildCandidatePairs(dependencies, advisoriesByOsvId, packageAdvisoryMap);

    expect(pairs).toHaveLength(2);
    expect(pairs.map((p) => p.dependency.depType).sort()).toEqual(["development", "production"]);
  });

  it("skips an advisory id with no matching entry in advisoriesByOsvId", () => {
    const dependencies = [
      {
        id: "dep-1",
        repoId: "repo-1",
        ecosystem: "npm" as const,
        packageName: "lodash",
        versionSpec: "^4.0.0",
        resolvedVersion: null,
        depType: "production" as const,
        latestVersion: null,
        isDeprecated: false,
        deprecationNote: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    // GHSA-missing was in the package map but never made it into
    // advisoriesByOsvId — mirrors a failed detail fetch upstream.
    const packageAdvisoryMap = new Map([["lodash", ["GHSA-missing"]]]);

    const pairs = buildCandidatePairs(dependencies, new Map(), packageAdvisoryMap);

    expect(pairs).toEqual([]);
  });

  it("produces no pairs when no dependency matches the advisory's package name", () => {
    const dependencies: never[] = [];
    const advisoriesByOsvId = new Map([["GHSA-1", makeAdvisory("GHSA-1")]]);
    const packageAdvisoryMap = new Map([["left-pad", ["GHSA-1"]]]);

    const pairs = buildCandidatePairs(dependencies, advisoriesByOsvId, packageAdvisoryMap);

    expect(pairs).toEqual([]);
  });
});
