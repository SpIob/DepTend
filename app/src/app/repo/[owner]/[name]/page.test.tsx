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
        return "Ingesting…";
      case "failed":
        return "Ingestion failed";
      case "skipped":
        return "No manifest found";
      case "complete":
        return null;
    }
  },
  ingestionStatusDetail: (status: string, error: string | null) => {
    switch (status) {
      case "pending":
        return "This repo is queued for ingestion. It will be processed automatically.";
      case "running":
        return "Ingestion is currently in progress. Check back in a few minutes.";
      case "failed":
        return error
          ? `Ingestion failed: ${error}. It will be retried automatically.`
          : "Ingestion failed with no error details. It will be retried automatically.";
      case "skipped":
        return error
          ? `No analyzable manifest found: ${error}. Ensure a package.json, pyproject.toml, requirements.txt, go.mod, or Cargo.toml exists at the repository root.`
          : "No analyzable manifest found. Ensure a package.json, pyproject.toml, requirements.txt, go.mod, or Cargo.toml exists at the repository root.";
      case "complete":
        return "Indexed successfully.";
    }
  },
}));

vi.mock("@/lib/relative-time", () => ({
  formatRelativeTime: (date: Date) => {
    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}h ago`;
    const diffDay = Math.floor(diffHour / 24);
    return `${diffDay}d ago`;
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

describe("RepoPage - complete repo with freshness and badge", () => {
  const now = Date.now();
  const recentDate = new Date(now - 6 * 60 * 60 * 1000); // 6 hours ago

  const completeRepoWithMissions = {
    id: "repo-3",
    owner: "testowner",
    name: "testrepo3",
    githubUrl: "https://github.com/testowner/testrepo3",
    description: "Test repo with missions",
    stars: 42,
    openIssuesCount: 3,
    topics: ["typescript", "security"],
    homepageUrl: null,
    ingestionStatus: "complete" as const,
    lastIngestedAt: recentDate,
    ingestionError: null,
    submittedBy: "testuser",
    orgId: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  };

  const boardWithMissions = {
    missions: [{ id: "m-1", title: "Mission 1" } as any, { id: "m-2", title: "Mission 2" } as any],
    total: 12,
    facets: {
      severity: { critical: 1, high: 3, medium: 5, low: 3, unknown: 0 },
      ecosystem: { npm: 12 },
      effort: { trivial: 2, low: 5, medium: 3, high: 2 },
      missionType: { vulnerability_fix: 8, dep_update: 4 },
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetRepoByOwnerAndName.mockResolvedValue(completeRepoWithMissions);
    mockGetRepoBoardPage.mockResolvedValue(boardWithMissions);
    mockGetBookmarkedRepoIds.mockResolvedValue(new Set());
    mockGetRepoEcosystems.mockResolvedValue(["npm"]);

    const { getServerSession } = await import("next-auth");
    vi.mocked(getServerSession).mockResolvedValue(null);
  });

  it("renders freshness as 'last scanned X ago' with absolute timestamp as title", async () => {
    const { default: RepoPage } = await import("./page");

    const element = await RepoPage({
      params: Promise.resolve({ owner: "testowner", name: "testrepo3" }),
      searchParams: Promise.resolve({}),
    });

    const html = renderToString(element);

    // Should show relative time
    expect(html).toContain("last scanned");
    expect(html).toContain("6h ago");
    // Should have absolute timestamp as title/tooltip
    expect(html).toContain(recentDate.toLocaleString());
    expect(html).toContain("cursor-help");
  });

  it("renders badge disclosure with copy-paste markdown snippet", async () => {
    const { default: RepoPage } = await import("./page");

    const element = await RepoPage({
      params: Promise.resolve({ owner: "testowner", name: "testrepo3" }),
      searchParams: Promise.resolve({}),
    });

    const html = renderToString(element);

    // Badge disclosure should be present
    expect(html).toContain("Badge for this repo");
    expect(html).toContain("Embed this in your README");
    // Markdown snippet should contain the live origin
    expect(html).toContain("![depTend](");
    expect(html).toContain("/api/repos/testowner/testrepo3/badge.svg");
  });
});

describe("RepoPage - failed repo with error reason", () => {
  const failedRepo = {
    id: "repo-4",
    owner: "testowner",
    name: "failedrepo",
    githubUrl: "https://github.com/testowner/failedrepo",
    description: "Failed repo",
    stars: 10,
    openIssuesCount: 0,
    topics: [],
    homepageUrl: null,
    ingestionStatus: "failed" as const,
    lastIngestedAt: new Date("2024-01-01"),
    ingestionError: "GitHub API rate limit exceeded",
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
    mockGetRepoByOwnerAndName.mockResolvedValue(failedRepo);
    mockGetRepoBoardPage.mockResolvedValue(emptyBoard);
    mockGetBookmarkedRepoIds.mockResolvedValue(new Set());
    mockGetRepoEcosystems.mockResolvedValue([]);

    const { getServerSession } = await import("next-auth");
    vi.mocked(getServerSession).mockResolvedValue(null);
  });

  it("renders detailed status with ingestionError for failed repo", async () => {
    const { default: RepoPage } = await import("./page");

    const element = await RepoPage({
      params: Promise.resolve({ owner: "testowner", name: "failedrepo" }),
      searchParams: Promise.resolve({}),
    });

    const html = renderToString(element);

    // Should show the detailed status with error
    expect(html).toContain("Ingestion failed: GitHub API rate limit exceeded");
    expect(html).toContain("It will be retried automatically");
  });
});

describe("RepoPage - skipped repo with error reason", () => {
  const skippedRepoWithError = {
    id: "repo-5",
    owner: "testowner",
    name: "skippedrepo",
    githubUrl: "https://github.com/testowner/skippedrepo",
    description: "Skipped repo with error",
    stars: 5,
    openIssuesCount: 0,
    topics: [],
    homepageUrl: null,
    ingestionStatus: "skipped" as const,
    lastIngestedAt: new Date("2024-01-01"),
    ingestionError: "No package.json found at repository root",
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
    mockGetRepoByOwnerAndName.mockResolvedValue(skippedRepoWithError);
    mockGetRepoBoardPage.mockResolvedValue(emptyBoard);
    mockGetBookmarkedRepoIds.mockResolvedValue(new Set());
    mockGetRepoEcosystems.mockResolvedValue([]);

    const { getServerSession } = await import("next-auth");
    vi.mocked(getServerSession).mockResolvedValue(null);
  });

  it("renders detailed status with ingestionError for skipped repo", async () => {
    const { default: RepoPage } = await import("./page");

    const element = await RepoPage({
      params: Promise.resolve({ owner: "testowner", name: "skippedrepo" }),
      searchParams: Promise.resolve({}),
    });

    const html = renderToString(element);

    // Should show the detailed status with error
    expect(html).toContain(
      "No analyzable manifest found: No package.json found at repository root",
    );
    expect(html).toContain("Ensure a package.json");
  });
});
