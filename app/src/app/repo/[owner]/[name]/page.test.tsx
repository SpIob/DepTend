import { describe, it, expect, vi, beforeEach } from "vitest";
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import React from "react";
import { renderToString } from "react-dom/server";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

// Mock next-auth
vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

// Mock next/link
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement("a", { href }, children),
}));

// Mock @deptend/core types
vi.mock("@deptend/core", () => ({
  Repo: {
    id: "",
    owner: "",
    name: "",
    githubUrl: "",
    description: null,
    stars: 0,
    openIssuesCount: 0,
    topics: [],
    homepageUrl: null,
    ingestionStatus: "pending" as const,
    lastIngestedAt: null,
    ingestionError: null,
    submittedBy: null,
    orgId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  MissionWithScore: {} as any,
  BoardFilters: {} as any,
  BoardFacets: {} as any,
  BoardPage: {} as any,
  Ecosystem: "" as "npm" | "pypi" | "go",
}));

// Mock queries
const mockGetRepoByOwnerAndName = vi.fn();
const mockGetRepoBoardPage = vi.fn();
const mockGetBookmarkedRepoIds = vi.fn();
const mockGetRepoEcosystems = vi.fn();

vi.mock("@/lib/queries/missions", () => ({
  getRepoByOwnerAndName: mockGetRepoByOwnerAndName,
  getRepoBoardPage: mockGetRepoBoardPage,
  getBookmarkedRepoIds: mockGetBookmarkedRepoIds,
  getRepoEcosystems: mockGetRepoEcosystems,
  BoardFilters: {} as any,
}));

// Mock mission-board-server
vi.mock("@/lib/mission-board-server", () => ({
  parseAndValidateBoardQuery: vi.fn().mockResolvedValue({
    q: "",
    severity: new Set(),
    ecosystem: new Set(),
    effort: new Set(),
    missionType: new Set(),
    sort: "priority",
    group: false,
    page: 1,
  }),
  buildBoardFilters: vi.fn().mockReturnValue({
    q: "",
    severities: [],
    ecosystems: [],
    efforts: [],
    missionTypes: [],
    sort: "priority",
  }),
  buildRepoBoardBasePath: vi.fn().mockReturnValue("/repo/test/repo"),
}));

// Mock components
vi.mock("@/components/auth-status", () => ({
  AuthStatus: () => React.createElement("span", null, "AuthStatus"),
}));

vi.mock("@/components/bookmark-toggle", () => ({
  BookmarkToggle: () => React.createElement("span", null, "BookmarkToggle"),
}));

vi.mock("@/components/withdraw-button", () => ({
  WithdrawButton: () => React.createElement("span", null, "WithdrawButton"),
}));

vi.mock("@/components/ecosystem-badge", () => ({
  EcosystemBadge: ({ ecosystem }: { ecosystem: string }) =>
    React.createElement("span", null, ecosystem),
}));

vi.mock("@/components/brand-mark", () => ({
  BrandMark: () => React.createElement("span", null, "BrandMark"),
}));

vi.mock("@/components/page-header", () => ({
  PageHeader: ({ children, left, right }: any) =>
    React.createElement("header", null, left, right, children),
}));

vi.mock("@/lib/ingestion-status", () => ({
  ingestionStatusNote: (status: string) => {
    switch (status) {
      case "pending":
        return "Pending ingestion";
      case "running":
        return "Ingesting...";
      case "failed":
        return "Ingestion failed";
      case "skipped":
        return "No manifest found";
      case "complete":
        return null;
    }
  },
}));

vi.mock("@/components/paginated-mission-board", () => ({
  PaginatedMissionBoard: () => React.createElement("div", null, "PaginatedMissionBoard"),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

import RepoPage from "./page";

describe("RepoPage - skipped repo rendering", () => {
  const skippedRepo = {
    id: "repo-1",
    owner: "testowner",
    name: "testrepo",
    githubUrl: "https://github.com/testowner/testrepo",
    description: "Test repo",
    stars: 10,
    openIssuesCount: 0,
    topics: [],
    homepageUrl: null,
    ingestionStatus: "skipped" as const,
    lastIngestedAt: null,
    ingestionError: null,
    submittedBy: "testuser",
    orgId: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  };

  const emptyBoard = {
    missions: [],
    total: 0,
    facets: {
      severity: {},
      ecosystem: {},
      effort: {},
      missionType: {},
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetRepoByOwnerAndName.mockResolvedValue(skippedRepo);
    mockGetRepoBoardPage.mockResolvedValue(emptyBoard);
    mockGetBookmarkedRepoIds.mockResolvedValue(new Set());
    mockGetRepoEcosystems.mockResolvedValue([]);

    // Mock getServerSession to return no session (signed out)
    const { getServerSession } = await import("next-auth");
    vi.mocked(getServerSession).mockResolvedValue(null);
  });

  it("renders EmptyState with 'No manifest found' for skipped repo", async () => {
    const { default: RepoPage } = await import("./page");

    // Render the page
    const element = await RepoPage({
      params: Promise.resolve({ owner: "testowner", name: "testrepo" }),
      searchParams: Promise.resolve({}),
    });

    const html = renderToString(element);

    // Check that "No manifest found" appears in the output
    expect(html).toContain("No manifest found");
    expect(html).toContain("No open missions for this repo");
  });

  it("renders WithdrawButton for skipped repo", async () => {
    const { default: RepoPage } = await import("./page");

    const element = await RepoPage({
      params: Promise.resolve({ owner: "testowner", name: "testrepo" }),
      searchParams: Promise.resolve({}),
    });

    const html = renderToString(element);

    // WithdrawButton should be rendered
    expect(html).toContain("WithdrawButton");
  });

  it("does NOT render PaginatedMissionBoard for skipped repo", async () => {
    const { default: RepoPage } = await import("./page");

    const element = await RepoPage({
      params: Promise.resolve({ owner: "testowner", name: "testrepo" }),
      searchParams: Promise.resolve({}),
    });

    const html = renderToString(element);

    // PaginatedMissionBoard should NOT be rendered when statusNote !== null
    expect(html).not.toContain("PaginatedMissionBoard");
  });
});

describe("RepoPage - complete repo with no missions", () => {
  const completeRepo = {
    id: "repo-2",
    owner: "testowner",
    name: "testrepo2",
    githubUrl: "https://github.com/testowner/testrepo2",
    description: "Test repo 2",
    stars: 5,
    openIssuesCount: 0,
    topics: [],
    homepageUrl: null,
    ingestionStatus: "complete" as const,
    lastIngestedAt: new Date("2024-01-01"),
    ingestionError: null,
    submittedBy: "testuser",
    orgId: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  };

  const emptyBoard = {
    missions: [],
    total: 0,
    facets: {
      severity: {},
      ecosystem: {},
      effort: {},
      missionType: {},
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetRepoByOwnerAndName.mockResolvedValue(completeRepo);
    mockGetRepoBoardPage.mockResolvedValue(emptyBoard);
    mockGetBookmarkedRepoIds.mockResolvedValue(new Set());
    mockGetRepoEcosystems.mockResolvedValue([]);

    const { getServerSession } = await import("next-auth");
    vi.mocked(getServerSession).mockResolvedValue(null);
  });

  it("renders EmptyState with default note for complete repo with no missions", async () => {
    const { default: RepoPage } = await import("./page");

    const element = await RepoPage({
      params: Promise.resolve({ owner: "testowner", name: "testrepo2" }),
      searchParams: Promise.resolve({}),
    });

    const html = renderToString(element);

    // Check for the default note text (HTML-encodes apostrophes as ')
    expect(html).toContain("Either it");
    expect(html).toContain("in good shape");
    expect(html).toContain("finished ingesting yet");
  });
});
