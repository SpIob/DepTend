import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { MissionMeta } from "./MissionMeta";
import type { MissionWithScore } from "@deptend/core";

function makeMission(
  overrides: Partial<{
    claimedBy: string | null;
    repoOwner: string;
    repoOrgId: string | null;
  }> = {},
): MissionWithScore {
  return {
    id: "mission-1",
    repoId: "repo-1",
    title: "Test mission",
    description: "Test description",
    actionHint: null,
    missionType: "vulnerability_fix",
    status: "open",
    advisoryId: null,
    dependencyId: null,
    claimedBy: overrides.claimedBy ?? null,
    claimedAt: null,
    resolvedAt: null,
    dismissedAt: null,
    dismissReason: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    score: {
      id: "score-1",
      missionId: "mission-1",
      impactScore: 5.0,
      ecosystemValueScore: 5.0,
      compositeScore: 5.0,
      effortLabel: "low",
      impactInputs: {
        cvss_score: 7.5,
        severity: "high",
        is_transitive: false,
        dep_type: "production",
        days_since_advisory: 30,
        epss_score: 0.1,
      },
      ecosystemValueInputs: { repo_stars: 10, open_issues_count: 0, downstream_dependents: null },
      effortInputs: {
        semver_bump: "minor",
        has_migration_guide: false,
        breaking_change_signals: [],
      },
      confidence: "high",
      confidenceNotes: [],
      confidenceFlags: {},
      scoringVersion: "0.1.0",
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    },
    advisory: null,
    dependency: null,
    repo: {
      id: "repo-1",
      githubUrl: "https://github.com/test-owner/test-repo",
      owner: overrides.repoOwner ?? "test-owner",
      name: "test-repo",
      defaultBranch: "main",
      description: "Test repo",
      stars: 100,
      openIssuesCount: 5,
      topics: [],
      homepageUrl: null,
      ingestionStatus: "complete",
      lastIngestedAt: new Date("2024-01-01"),
      ingestionError: null,
      submittedBy: "test-user",
      orgId: overrides.repoOrgId ?? null,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    },
  } as MissionWithScore;
}

describe("MissionMeta - repo owner mark", () => {
  it("shows 'repo owner' tag when claimedBy === repo.owner and repo has no orgId", () => {
    const mission = makeMission({ claimedBy: "test-owner", repoOwner: "test-owner" });
    const html = renderToString(<MissionMeta mission={mission} />);

    expect(html).toContain("repo owner");
  });

  it("does NOT show 'repo owner' tag when claimedBy differs from repo.owner", () => {
    const mission = makeMission({ claimedBy: "someone-else", repoOwner: "test-owner" });
    const html = renderToString(<MissionMeta mission={mission} />);

    expect(html).not.toContain("repo owner");
  });

  it("does NOT show 'repo owner' tag when mission is not claimed", () => {
    const mission = makeMission({ claimedBy: null, repoOwner: "test-owner" });
    const html = renderToString(<MissionMeta mission={mission} />);

    expect(html).not.toContain("repo owner");
  });

  it("does NOT show 'repo owner' tag when repo has orgId (org-owned repo)", () => {
    const mission = makeMission({
      claimedBy: "test-owner",
      repoOwner: "test-owner",
      repoOrgId: "org-123",
    });
    const html = renderToString(<MissionMeta mission={mission} />);

    expect(html).not.toContain("repo owner");
  });

  it("does NOT show 'repo owner' tag when repo has orgId even if claimedBy matches", () => {
    const mission = makeMission({
      claimedBy: "test-owner",
      repoOwner: "test-owner",
      repoOrgId: "org-123",
    });
    const html = renderToString(<MissionMeta mission={mission} />);

    expect(html).not.toContain("repo owner");
  });
});
