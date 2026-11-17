import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

// Mock next/link
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement("a", { href }, children),
}));

// Mock @deptend/core types
vi.mock("@deptend/core", () => ({
  MissionWithScore: {},
}));

// Mock queries - use vi.hoisted to avoid hoisting issues
const { mockGetMissionById } = vi.hoisted(() => ({
  mockGetMissionById: vi.fn(),
}));

vi.mock("@/lib/queries/missions", () => ({
  getMissionById: mockGetMissionById,
}));

// Mock components
vi.mock("@/components/mission-card/MissionHeader", () => ({
  MissionHeader: ({ mission }: { mission: { title: string } }) =>
    React.createElement("div", { "data-testid": "mission-header" }, mission.title),
}));

vi.mock("@/components/mission-card/MissionScoreDetails", () => ({
  MissionScoreDetails: () => React.createElement("div", { "data-testid": "mission-score-details" }),
}));

vi.mock("@/components/mission-card/ScoreInputsList", () => ({
  ScoreInputsList: () => React.createElement("div", { "data-testid": "score-inputs-list" }),
}));

vi.mock("@/components/mission-card/constants", () => ({
  CONFIDENCE_TEXT: { high: "High confidence", medium: "Medium confidence", low: "Low confidence" },
  CONFIDENCE_CLASS: { high: "", medium: "", low: "" },
  CONFIDENCE_NOTES_BLOCK: "",
  CONFIDENCE_NOTES_HEADING: "",
  CONFIDENCE_NOTES_HEADING_DEFAULT: "",
  MISSION_TYPE_CLASS: { vulnerability_fix: "", dep_update: "", maintenance: "", license_issue: "" },
}));

vi.mock("@/components/mission-card/utils", () => ({
  osvUrl: (osvId: string) => `https://osv.dev/vulnerability/${osvId}`,
}));

vi.mock("@/lib/timing/log", () => ({
  logRequestTimings: vi.fn().mockResolvedValue(undefined),
}));

import MissionPage from "./page";

const mockMission = {
  id: "mission-1",
  repoId: "repo-1",
  title: "Update lodash to fix vulnerability",
  description: "Description of the mission",
  actionHint: "Upgrade to 4.17.21",
  missionType: "vulnerability_fix" as const,
  status: "open" as const,
  advisoryId: "advisory-1",
  dependencyId: "dependency-1",
  claimedBy: null,
  claimedAt: null,
  resolvedAt: null,
  dismissedAt: null,
  dismissReason: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
  score: {
    id: "score-1",
    missionId: "mission-1",
    impactScore: 7.5,
    ecosystemValueScore: 5.0,
    compositeScore: 6.5,
    effortLabel: "low" as const,
    impactInputs: {
      cvss_score: 7.5,
      severity: "high" as const,
      is_transitive: false,
      dep_type: "production" as const,
      days_since_advisory: 30,
      epss_score: 0.1,
    },
    ecosystemValueInputs: { repo_stars: 100, open_issues_count: 10, downstream_dependents: null },
    effortInputs: { semver_bump: "minor", has_migration_guide: false, breaking_change_signals: [] },
    confidence: "medium" as const,
    confidenceNotes: [],
    confidenceFlags: {},
    scoringVersion: "0.1.0",
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  },
  advisory: {
    id: "advisory-1",
    osvId: "GHSA-test123",
    source: "osv" as const,
    ecosystem: "npm" as const,
    severity: "high" as const,
    cvssScore: 7.5,
    epssScore: 0.1,
    fixedVersion: "4.17.21",
    publishedAt: new Date("2024-01-01"),
  },
  dependency: {
    id: "dependency-1",
    repoId: "repo-1",
    ecosystem: "npm" as const,
    packageName: "lodash",
    versionSpec: "^4.17.20",
    resolvedVersion: "4.17.20",
    depType: "production" as const,
    latestVersion: "4.17.21",
    isDeprecated: false,
    deprecationNote: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  },
  repo: {
    id: "repo-1",
    githubUrl: "https://github.com/test-owner/test-repo",
    owner: "test-owner",
    name: "test-repo",
    defaultBranch: "main",
    description: "Test repo",
    stars: 100,
    openIssuesCount: 5,
    topics: [],
    homepageUrl: null,
    ingestionStatus: "complete" as const,
    lastIngestedAt: new Date("2024-01-01"),
    ingestionError: null,
    submittedBy: "test-user",
    orgId: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  },
};

describe("MissionPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMissionById.mockResolvedValue(mockMission);
  });

  it("renders mission details when mission exists", async () => {
    const element = await MissionPage({
      params: Promise.resolve({ id: "mission-1" }),
    });

    const html = renderToString(element);

    expect(html).toContain("Update lodash to fix vulnerability");
    expect(html).toContain("Description of the mission");
    expect(html).toContain("Upgrade to 4.17.21");
    expect(html).toContain("test-owner/test-repo");
    expect(html).toContain("GHSA-test123");
    expect(html).toContain("4.17.21");
    expect(html).toContain("Medium confidence");
    expect(html).toContain('data-testid="mission-score-details"');
    expect(html).toContain('data-testid="score-inputs-list"');
  });

  it("renders 404 when mission does not exist", async () => {
    mockGetMissionById.mockResolvedValue(null);

    await expect(
      MissionPage({
        params: Promise.resolve({ id: "nonexistent" }),
      }),
    ).rejects.toThrow("NOT_FOUND");
  });

  it("renders breadcrumbs with correct links", async () => {
    const element = await MissionPage({
      params: Promise.resolve({ id: "mission-1" }),
    });

    const html = renderToString(element);

    expect(html).toContain('href="/"');
    expect(html).toContain('href="/missions"');
    expect(html).toContain('href="/repo/test-owner/test-repo"');
  });

  it("renders advisory details section", async () => {
    const element = await MissionPage({
      params: Promise.resolve({ id: "mission-1" }),
    });

    const html = renderToString(element);

    expect(html).toContain("Advisory");
    expect(html).toContain("Source");
    expect(html).toContain("OSV");
    expect(html).toContain("OSV ID");
    expect(html).toContain("GHSA-test123");
    expect(html).toContain("Package");
    expect(html).toContain("lodash");
    expect(html).toContain("Severity");
    expect(html).toContain("high");
    expect(html).toContain("CVSS");
    expect(html).toContain("7.5");
    expect(html).toContain("Fixed version");
    expect(html).toContain("4.17.21");
    expect(html).toContain("Published");
  });

  it("renders mission status section", async () => {
    const element = await MissionPage({
      params: Promise.resolve({ id: "mission-1" }),
    });

    const html = renderToString(element);

    expect(html).toContain("Status");
    expect(html).toContain("open");
  });

  it("renders back links", async () => {
    const element = await MissionPage({
      params: Promise.resolve({ id: "mission-1" }),
    });

    const html = renderToString(element);

    expect(html).toContain("All missions");
    expect(html).toContain("Repo board");
    expect(html).toContain('href="/missions"');
    expect(html).toContain('href="/repo/test-owner/test-repo"');
  });

  it("renders claimed by info when mission is claimed", async () => {
    const claimedMission = {
      ...mockMission,
      status: "claimed" as const,
      claimedBy: "octocat",
      claimedAt: new Date("2024-01-15"),
    };
    mockGetMissionById.mockResolvedValue(claimedMission);

    const element = await MissionPage({
      params: Promise.resolve({ id: "mission-1" }),
    });

    const html = renderToString(element);

    expect(html).toContain("Claimed by");
    expect(html).toContain("octocat");
    expect(html).toContain("Claimed at");
  });

  it("renders dismissed info when mission is dismissed", async () => {
    const dismissedMission = {
      ...mockMission,
      status: "dismissed" as const,
      dismissedAt: new Date("2024-01-15"),
      dismissReason: "upstream won't fix",
    };
    mockGetMissionById.mockResolvedValue(dismissedMission);

    const element = await MissionPage({
      params: Promise.resolve({ id: "mission-1" }),
    });

    const html = renderToString(element);

    expect(html).toContain("Dismissed at");
    expect(html).toContain("Reason");
    // HTML-escaped apostrophe in the rendered output
    expect(html).toContain("upstream won&#x27;t fix");
  });
});
