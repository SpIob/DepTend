/**
 * Route-level tests for GET /api/badge/[owner]/[name]
 * Read-only route — no same-origin gate needed (ADR 0037 applies to mutating routes).
 *
 * Lives under /api/badge, NOT /api/repos/[owner]/[name]: Next requires
 * consistent slug names at each dynamic segment position, and the existing
 * /api/repos/[id]/... tree already claims position one for `id`. The first
 * cut used /api/repos/[owner]/[name]/badge.svg and 500'd every /api/repos
 * route in production while its colocated handler tests stayed green
 * (route-table conflicts are invisible to direct-handler tests; covered now
 * by app/src/app/api/route-tree.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

// ---- Top-level mocks ----
const getDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ getDb }));

const DB = { __readonlyDbSentinel: true } as const;
getDb.mockReturnValue(DB);

const getRepoByOwnerAndName = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/repos.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRepoByOwnerAndName,
}));

const getRepoBoardPage = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/board-queries.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRepoBoardPage,
}));

describe("GET /api/badge/[owner]/[name]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getDb.mockReturnValue(DB);
  });

  it("returns 404 for unknown repo", async () => {
    getRepoByOwnerAndName.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/badge/unknown/repo"), {
      params: Promise.resolve({ owner: "unknown", name: "repo" }),
    });

    expect(response.status).toBe(404);
    expect(getRepoByOwnerAndName).toHaveBeenCalledWith(expect.anything(), "unknown", "repo");
  });

  it("returns SVG with correct content type and cache headers for known repo", async () => {
    const mockRepo = {
      id: "repo-1",
      owner: "testowner",
      name: "testrepo",
      githubUrl: "https://github.com/testowner/testrepo",
      description: "Test repo",
      stars: 10,
      openIssuesCount: 0,
      topics: [],
      homepageUrl: null,
      ingestionStatus: "complete" as const,
      lastIngestedAt: new Date(),
      ingestionError: null,
      submittedBy: "testuser",
      orgId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    getRepoByOwnerAndName.mockResolvedValue(mockRepo);
    getRepoBoardPage.mockResolvedValue({
      missions: [],
      total: 12,
      facets: {
        severity: { critical: 1, high: 3, medium: 5, low: 3, unknown: 0 },
        ecosystem: {},
        effort: {},
        missionType: {},
      },
    });

    const response = await GET(new Request("http://localhost/api/badge/testowner/testrepo"), {
      params: Promise.resolve({ owner: "testowner", name: "testrepo" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=3600",
    );

    const svg = await response.text();
    expect(svg).toContain("depTend");
    expect(svg).toContain("12 missions · 3 high");
    expect(svg).not.toContain("clean");
  });

  it("returns 'clean' badge when zero open missions", async () => {
    const mockRepo = {
      id: "repo-2",
      owner: "cleanowner",
      name: "cleanrepo",
      githubUrl: "https://github.com/cleanowner/cleanrepo",
      description: "Clean repo",
      stars: 5,
      openIssuesCount: 0,
      topics: [],
      homepageUrl: null,
      ingestionStatus: "complete" as const,
      lastIngestedAt: new Date(),
      ingestionError: null,
      submittedBy: "testuser",
      orgId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    getRepoByOwnerAndName.mockResolvedValue(mockRepo);
    getRepoBoardPage.mockResolvedValue({
      missions: [],
      total: 0,
      facets: {
        severity: {},
        ecosystem: {},
        effort: {},
        missionType: {},
      },
    });

    const response = await GET(new Request("http://localhost/api/badge/cleanowner/cleanrepo"), {
      params: Promise.resolve({ owner: "cleanowner", name: "cleanrepo" }),
    });

    expect(response.status).toBe(200);
    const svg = await response.text();
    expect(svg).toContain("clean");
    expect(svg).not.toContain("missions");
  });

  it("XML-escapes owner and name in SVG output", async () => {
    const mockRepo = {
      id: "repo-3",
      owner: "test&owner",
      name: "test<repo>",
      githubUrl: "https://github.com/test&owner/test<repo>",
      description: "Test repo",
      stars: 10,
      openIssuesCount: 0,
      topics: [],
      homepageUrl: null,
      ingestionStatus: "complete" as const,
      lastIngestedAt: new Date(),
      ingestionError: null,
      submittedBy: "testuser",
      orgId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    getRepoByOwnerAndName.mockResolvedValue(mockRepo);
    getRepoBoardPage.mockResolvedValue({
      missions: [],
      total: 5,
      facets: {
        severity: { high: 2 },
        ecosystem: {},
        effort: {},
        missionType: {},
      },
    });

    const response = await GET(
      new Request("http://localhost/api/badge/test%26owner/test%3Crepo%3E"),
      { params: Promise.resolve({ owner: "test&owner", name: "test<repo>" }) },
    );

    const svg = await response.text();
    // XML entities should appear in the SVG, not raw characters
    // Using numeric character references (&#38; for &, &#60; for <, &#62; for >)
    expect(svg).toContain("test&#38;owner");
    expect(svg).toContain("test&#60;repo&#62;");
    expect(svg).not.toContain("test&owner");
    expect(svg).not.toContain("test<repo>");
  });

  it("XML-escapes dynamic message content", async () => {
    const mockRepo = {
      id: "repo-4",
      owner: "owner",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      description: "Test repo",
      stars: 10,
      openIssuesCount: 0,
      topics: [],
      homepageUrl: null,
      ingestionStatus: "complete" as const,
      lastIngestedAt: new Date(),
      ingestionError: null,
      submittedBy: "testuser",
      orgId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    getRepoByOwnerAndName.mockResolvedValue(mockRepo);
    getRepoBoardPage.mockResolvedValue({
      missions: [],
      total: 1,
      facets: {
        severity: { high: 1 },
        ecosystem: {},
        effort: {},
        missionType: {},
      },
    });

    const response = await GET(new Request("http://localhost/api/badge/owner/repo"), {
      params: Promise.resolve({ owner: "owner", name: "repo" }),
    });

    const svg = await response.text();
    // The message contains "1 mission · 1 high" which has no special chars,
    // but the escaping function should still work correctly
    expect(svg).toContain("1 mission · 1 high");
  });
});
