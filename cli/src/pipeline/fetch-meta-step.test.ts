/**
 * runFetchMetaStep unit tests
 *
 * Tests the GitHub repo metadata fetch step in isolation.
 * Mocks fetch to simulate various GitHub API responses.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runFetchMetaStep } from "./fetch-meta-step.js";
import { createFetchRouter } from "../test/mocks/fetch-router.js";

describe("runFetchMetaStep", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and maps GitHub metadata to Repo shape", async () => {
    vi.stubGlobal("fetch", await createFetchRouter());

    const result = await runFetchMetaStep("owner", "repo", null);

    expect(result.repo.githubUrl).toBe("https://github.com/owner/repo");
    expect(result.repo.owner).toBe("owner");
    expect(result.repo.name).toBe("repo");
    expect(result.repo.defaultBranch).toBe("main");
    expect(result.repo.description).toBe("A test repo");
    expect(result.repo.stars).toBe(100);
    expect(result.repo.openIssuesCount).toBe(5);
    expect(result.repo.topics).toEqual([]);
    expect(result.repo.submittedBy).toBeNull();
    expect(result.repo.orgId).toBeNull();
    expect(result.repo.ingestionStatus).toBe("complete");
  });

  it("handles missing optional fields gracefully", async () => {
    const minimalMeta = {
      full_name: "owner/repo",
      name: "repo",
      owner: { login: "owner" },
      default_branch: "main",
      description: null,
      stargazers_count: 0,
      open_issues_count: 0,
      topics: null,
      homepage: null,
    };
    vi.stubGlobal("fetch", await createFetchRouter({ githubMeta: minimalMeta }));

    const result = await runFetchMetaStep("owner", "repo", null);

    expect(result.repo.description).toBeNull();
    expect(result.repo.stars).toBe(0);
    expect(result.repo.openIssuesCount).toBe(0);
    expect(result.repo.topics).toEqual([]);
    expect(result.repo.homepageUrl).toBeNull();
  });

  it("handles 404 (repo not found)", async () => {
    vi.stubGlobal(
      "fetch",
      await createFetchRouter({
        githubMeta: { message: "Not Found" },
      }),
    );

    await expect(runFetchMetaStep("owner", "nonexistent", null)).rejects.toThrow();
  });

  it("handles 403 (rate limited, no token)", async () => {
    vi.stubGlobal("fetch", async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.github.com/repos/owner/repo")) {
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
        });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    });

    await expect(runFetchMetaStep("owner", "repo", null)).rejects.toThrow();
  });

  it("handles network errors (non-retryable 400 response)", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", async (input) => {
      callCount++;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // Match the exact URL pattern used by fetchGitHubRepoMeta
      if (url === "https://api.github.com/repos/owner/repo") {
        // Return 400 (Bad Request) which is NOT retryable per fetchWithRetry
        return new Response(JSON.stringify({ message: "Bad Request" }), { status: 400 });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    });

    await expect(runFetchMetaStep("owner", "repo", null)).rejects.toThrow();
    expect(callCount).toBe(1);
  });

  it("passes githubToken to fetch call", async () => {
    let capturedToken: string | null = null;
    vi.stubGlobal("fetch", async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.github.com/repos/owner/repo") {
        const auth = init?.headers?.["Authorization"] || init?.headers?.["authorization"];
        capturedToken = auth?.replace("Bearer ", "") ?? null;
        return new Response(
          JSON.stringify({
            full_name: "owner/repo",
            name: "repo",
            owner: { login: "owner" },
            default_branch: "main",
            description: null,
            stargazers_count: 0,
            open_issues_count: 0,
            topics: [],
            homepage: null,
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unmocked fetch: ${url}`);
    });

    await runFetchMetaStep("owner", "repo", "ghp_testtoken123");

    expect(capturedToken).toBe("ghp_testtoken123");
  });

  it("does not send Authorization header when token is null", async () => {
    let hasAuth = false;
    vi.stubGlobal("fetch", async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.github.com/repos/owner/repo") {
        hasAuth = !!(init?.headers?.["Authorization"] || init?.headers?.["authorization"]);
        return new Response(
          JSON.stringify({
            full_name: "owner/repo",
            name: "repo",
            owner: { login: "owner" },
            default_branch: "main",
            description: null,
            stargazers_count: 0,
            open_issues_count: 0,
            topics: [],
            homepage: null,
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unmocked fetch: ${url}`);
    });

    await runFetchMetaStep("owner", "repo", null);

    expect(hasAuth).toBe(false);
  });

  it("handles private repo with valid token", async () => {
    vi.stubGlobal(
      "fetch",
      await createFetchRouter({
        githubMeta: {
          full_name: "owner/private-repo",
          name: "private-repo",
          owner: { login: "owner" },
          default_branch: "main",
          description: "Private repo",
          stargazers_count: 42,
          open_issues_count: 10,
          topics: ["private"],
          homepage: "https://example.com",
        },
      }),
    );

    const result = await runFetchMetaStep("owner", "private-repo", "ghp_validtoken");

    expect(result.repo.name).toBe("private-repo");
    expect(result.repo.stars).toBe(42);
    expect(result.repo.homepageUrl).toBe("https://example.com");
  });
});
