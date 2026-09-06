import { describe, expect, it } from "vitest";
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  filterMissions,
  sortMissions,
  applyFiltersAndSort,
  computeFacets,
  getSeverity,
  getEcosystem,
  getEffortLabel,
  getPackageName,
  getCompositeScore,
  getAdvisoryPublishedAt,
} from "./useClientSideFilters";
import type { MissionWithScore } from "@deptend/core";
import type { BoardFilters } from "@deptend/core/db/queries.js";
import type { Severity, Ecosystem, EffortLabel, MissionType } from "@deptend/core/db/schema.js";

function makeMission(
  overrides: {
    severity?: Severity;
    ecosystem?: Ecosystem;
    effortLabel?: EffortLabel;
    missionType?: MissionType;
    packageName?: string;
    repoOwner?: string;
    repoName?: string;
    advisoryId?: string;
    title?: string;
    compositeScore?: number;
    advisoryPublishedAt?: Date;
  } = {},
): MissionWithScore {
  const baseMission: MissionWithScore = {
    id: crypto.randomUUID(),
    repoId: crypto.randomUUID(),
    title: overrides.title ?? "Test vulnerability",
    description: "Test description",
    actionHint: null,
    missionType: overrides.missionType ?? "vulnerability_fix",
    status: "open",
    advisoryId: crypto.randomUUID(),
    dependencyId: crypto.randomUUID(),
    claimedBy: null,
    claimedAt: null,
    resolvedAt: null,
    dismissedAt: null,
    dismissReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    score: {
      id: crypto.randomUUID(),
      missionId: crypto.randomUUID(),
      impactScore: 5.0,
      ecosystemValueScore: 5.0,
      compositeScore: overrides.compositeScore ?? 5.0,
      effortLabel: overrides.effortLabel ?? "low",
      impactInputs: {
        cvss_score: 7.5,
        severity: overrides.severity ?? "high",
        is_transitive: false,
        dep_type: "production",
        days_since_advisory: 30,
        epss_score: 0.1,
      },
      ecosystemValueInputs: { repo_stars: 100, open_issues_count: 10, downstream_dependents: null },
      effortInputs: {
        semver_bump: "minor",
        has_migration_guide: false,
        breaking_change_signals: [],
      },
      confidence: "medium",
      confidenceNotes: [],
      confidenceFlags: {},
      scoringVersion: "0.1.0",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    advisory: {
      id: crypto.randomUUID(),
      osvId: overrides.advisoryId ?? "GHSA-test",
      source: "osv",
      ecosystem: overrides.ecosystem ?? "npm",
      severity: overrides.severity ?? "high",
      fixedVersion: "1.1.0",
      publishedAt: overrides.advisoryPublishedAt ?? new Date("2024-01-01"),
    },
    dependency: {
      id: crypto.randomUUID(),
      repoId: crypto.randomUUID(),
      ecosystem: overrides.ecosystem ?? "npm",
      packageName: overrides.packageName ?? "test-package",
      versionSpec: "^1.0.0",
      resolvedVersion: "1.0.0",
      depType: "production",
      latestVersion: "1.1.0",
      isDeprecated: false,
      deprecationNote: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    repo: {
      id: crypto.randomUUID(),
      githubUrl: "https://github.com/test-owner/test-repo",
      owner: overrides.repoOwner ?? "test-owner",
      name: overrides.repoName ?? "test-repo",
      defaultBranch: "main",
      description: "Test repo",
      stars: 100,
      openIssuesCount: 10,
      topics: [],
      homepageUrl: null,
      ingestionStatus: "complete",
      lastIngestedAt: new Date(),
      ingestionError: null,
      submittedBy: "test-user",
      orgId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };

  return baseMission;
}

function makeFilters(overrides: Partial<BoardFilters> = {}): BoardFilters {
  return {
    q: "",
    severities: [],
    ecosystems: [],
    efforts: [],
    missionTypes: [],
    sort: "priority",
    ...overrides,
  };
}

describe("useClientSideFilters", () => {
  describe("filterMissions", () => {
    it("returns all missions when no filters", () => {
      const missions = [makeMission(), makeMission({ severity: "critical" })];
      const result = filterMissions(missions, makeFilters());
      expect(result).toHaveLength(2);
    });

    it("filters by severity", () => {
      const missions = [
        makeMission({ severity: "critical" }),
        makeMission({ severity: "high" }),
        makeMission({ severity: "medium" }),
      ];
      const result = filterMissions(missions, makeFilters({ severities: ["critical"] }));
      expect(result).toHaveLength(1);
      expect(getSeverity(result[0]!)).toBe("critical");
    });

    it("filters by multiple severities", () => {
      const missions = [
        makeMission({ severity: "critical" }),
        makeMission({ severity: "high" }),
        makeMission({ severity: "medium" }),
      ];
      const result = filterMissions(missions, makeFilters({ severities: ["critical", "high"] }));
      expect(result).toHaveLength(2);
    });

    it("filters by ecosystem", () => {
      const missions = [
        makeMission({ ecosystem: "npm" }),
        makeMission({ ecosystem: "pypi" }),
        makeMission({ ecosystem: "go" }),
      ];
      const result = filterMissions(missions, makeFilters({ ecosystems: ["npm"] }));
      expect(result).toHaveLength(1);
      expect(getEcosystem(result[0]!)).toBe("npm");
    });

    it("filters by effort", () => {
      const missions = [
        makeMission({ effortLabel: "trivial" }),
        makeMission({ effortLabel: "low" }),
        makeMission({ effortLabel: "high" }),
      ];
      const result = filterMissions(missions, makeFilters({ efforts: ["trivial", "low"] }));
      expect(result).toHaveLength(2);
    });

    it("filters by mission type", () => {
      const missions = [
        makeMission({ missionType: "vulnerability_fix" }),
        makeMission({ missionType: "dep_update" }),
        makeMission({ missionType: "maintenance" }),
      ];
      const result = filterMissions(missions, makeFilters({ missionTypes: ["vulnerability_fix"] }));
      expect(result).toHaveLength(1);
    });

    it("filters by search query", () => {
      const missions = [
        makeMission({ packageName: "urllib3", repoName: "requests" }),
        makeMission({ packageName: "crypto", repoName: "golang" }),
      ];
      const result = filterMissions(missions, makeFilters({ q: "urllib" }));
      expect(result).toHaveLength(1);
      expect(getPackageName(result[0]!)).toBe("urllib3");
    });

    it("search is case-insensitive", () => {
      const missions = [makeMission({ packageName: "Urllib3" })];
      const result = filterMissions(missions, makeFilters({ q: "URLLIB" }));
      expect(result).toHaveLength(1);
    });

    it("combines multiple filters", () => {
      const missions = [
        makeMission({ severity: "critical", ecosystem: "npm", effortLabel: "low" }),
        makeMission({ severity: "high", ecosystem: "npm", effortLabel: "low" }),
        makeMission({ severity: "critical", ecosystem: "pypi", effortLabel: "low" }),
      ];
      const result = filterMissions(
        missions,
        makeFilters({ severities: ["critical"], ecosystems: ["npm"] }),
      );
      expect(result).toHaveLength(1);
      expect(getSeverity(result[0]!)).toBe("critical");
      expect(getEcosystem(result[0]!)).toBe("npm");
    });
  });

  describe("sortMissions", () => {
    it("sorts by priority (compositeScore desc)", () => {
      const missions = [
        makeMission({ compositeScore: 5.0 }),
        makeMission({ compositeScore: 9.0 }),
        makeMission({ compositeScore: 2.0 }),
      ];
      const result = sortMissions(missions, "priority");
      expect(getCompositeScore(result[0]!)).toBe(9.0);
      expect(getCompositeScore(result[1]!)).toBe(5.0);
      expect(getCompositeScore(result[2]!)).toBe(2.0);
    });

    it("sorts by quick-wins (effort asc, then score desc)", () => {
      const missions = [
        makeMission({ effortLabel: "high", compositeScore: 9.0 }),
        makeMission({ effortLabel: "low", compositeScore: 5.0 }),
        makeMission({ effortLabel: "low", compositeScore: 8.0 }),
        makeMission({ effortLabel: "trivial", compositeScore: 3.0 }),
      ];
      const result = sortMissions(missions, "quick-wins");
      expect(getEffortLabel(result[0]!)).toBe("trivial");
      expect(getEffortLabel(result[1]!)).toBe("low");
      expect(getCompositeScore(result[1]!)).toBe(8.0);
      expect(getEffortLabel(result[2]!)).toBe("low");
      expect(getCompositeScore(result[2]!)).toBe(5.0);
      expect(getEffortLabel(result[3]!)).toBe("high");
    });

    it("sorts by newest (advisoryPublishedAt desc)", () => {
      const missions = [
        makeMission({ advisoryPublishedAt: new Date("2024-01-01") }),
        makeMission({ advisoryPublishedAt: new Date("2024-03-01") }),
        makeMission({ advisoryPublishedAt: new Date("2024-02-01") }),
      ];
      const result = sortMissions(missions, "newest");
      expect(getAdvisoryPublishedAt(result[0]!)).toEqual(new Date("2024-03-01"));
      expect(getAdvisoryPublishedAt(result[1]!)).toEqual(new Date("2024-02-01"));
      expect(getAdvisoryPublishedAt(result[2]!)).toEqual(new Date("2024-01-01"));
    });
  });

  describe("applyFiltersAndSort", () => {
    it("filters then sorts", () => {
      const missions = [
        makeMission({ severity: "critical", compositeScore: 5.0 }),
        makeMission({ severity: "high", compositeScore: 9.0 }),
        makeMission({ severity: "critical", compositeScore: 8.0 }),
      ];
      const result = applyFiltersAndSort(
        missions,
        makeFilters({ severities: ["critical"] }),
        "priority",
      );
      expect(result).toHaveLength(2);
      expect(getCompositeScore(result[0]!)).toBe(8.0);
      expect(getCompositeScore(result[1]!)).toBe(5.0);
    });
  });

  describe("computeFacets", () => {
    it("counts severities", () => {
      const missions = [
        makeMission({ severity: "critical" }),
        makeMission({ severity: "critical" }),
        makeMission({ severity: "high" }),
      ];
      const facets = computeFacets(missions);
      expect(facets.severity.critical).toBe(2);
      expect(facets.severity.high).toBe(1);
    });

    it("counts ecosystems", () => {
      const missions = [
        makeMission({ ecosystem: "npm" }),
        makeMission({ ecosystem: "pypi" }),
        makeMission({ ecosystem: "npm" }),
      ];
      const facets = computeFacets(missions);
      expect(facets.ecosystem.npm).toBe(2);
      expect(facets.ecosystem.pypi).toBe(1);
    });

    it("counts efforts", () => {
      const missions = [
        makeMission({ effortLabel: "trivial" }),
        makeMission({ effortLabel: "low" }),
        makeMission({ effortLabel: "low" }),
      ];
      const facets = computeFacets(missions);
      expect(facets.effort.trivial).toBe(1);
      expect(facets.effort.low).toBe(2);
    });

    it("counts mission types", () => {
      const missions = [
        makeMission({ missionType: "vulnerability_fix" }),
        makeMission({ missionType: "dep_update" }),
        makeMission({ missionType: "vulnerability_fix" }),
      ];
      const facets = computeFacets(missions);
      expect(facets.missionType.vulnerability_fix).toBe(2);
      expect(facets.missionType.dep_update).toBe(1);
    });
  });
});
