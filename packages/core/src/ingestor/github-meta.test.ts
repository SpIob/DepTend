/**
 * fetchGitHubRepoMeta unit tests
 *
 * Uses Vitest's built-in fetch mocking via vi.stubGlobal so no network
 * calls are made — same convention as npm.test.ts/osv.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGitHubRepoMeta, GitHubMetaError } from "./github-meta.js";

const OWNER = "owner";
const NAME = "repo";

/** Disables the transport policy's backoff/deadline for failure-path tests. */
const NO_DELAY = { retryDelayMs: 0, timeoutMs: 0 } as const;

function mockFetch(status: number, body: unknown, headers?: Record<string, string>): typeof fetch {
  const init: ResponseInit = headers ? { status, headers } : { status };
  return vi.fn(() =>
    Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), init)),
  );
}

describe("fetchGitHubRepoMeta", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches and returns repo metadata on a 200 response", async () => {
    const body = {
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
    vi.stubGlobal("fetch", mockFetch(200, body));

    const result = await fetchGitHubRepoMeta(OWNER, NAME, null);

    expect(result).toEqual(body);
  });

  it("requests the correct URL with owner/name URL-encoded", async () => {
    const fetchMock = vi.fn((_input: string | URL) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            full_name: "a/b",
            name: "b",
            owner: { login: "a" },
            default_branch: "main",
            description: null,
            stargazers_count: 0,
            open_issues_count: 0,
            homepage: null,
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchGitHubRepoMeta("some owner", "some/repo", null);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/some%20owner/some%2Frepo",
      expect.anything(),
    );
  });

  it("sends an Authorization header when a token is provided", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              full_name: "owner/repo",
              name: "repo",
              owner: { login: "owner" },
              default_branch: "main",
              description: null,
              stargazers_count: 0,
              open_issues_count: 0,
              homepage: null,
            }),
            { status: 200 },
          ),
        );
      }),
    );

    await fetchGitHubRepoMeta(OWNER, NAME, "test-token-123");

    expect(capturedHeaders?.Authorization).toBe("Bearer test-token-123");
  });

  it("omits the Authorization header when token is null", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              full_name: "owner/repo",
              name: "repo",
              owner: { login: "owner" },
              default_branch: "main",
              description: null,
              stargazers_count: 0,
              open_issues_count: 0,
              homepage: null,
            }),
            { status: 200 },
          ),
        );
      }),
    );

    await fetchGitHubRepoMeta(OWNER, NAME, null);

    expect(capturedHeaders?.Authorization).toBeUndefined();
  });

  it("throws a descriptive GitHubMetaError on 404 (repo not found)", async () => {
    vi.stubGlobal("fetch", mockFetch(404, null));

    const err = (await fetchGitHubRepoMeta(OWNER, NAME, null).catch(
      (e: unknown) => e,
    )) as GitHubMetaError;

    expect(err).toBeInstanceOf(GitHubMetaError);
    expect(err.kind).toBe("not_found");
    expect(err.message).toMatch(/GitHub repo not found: owner\/repo/);
  });

  it("throws a rate-limit error with reset time on 403", async () => {
    const resetEpoch = 1_800_000_000; // arbitrary fixed epoch seconds
    vi.stubGlobal(
      "fetch",
      mockFetch(403, null, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetEpoch),
      }),
    );

    await expect(fetchGitHubRepoMeta(OWNER, NAME, null)).rejects.toThrow(
      /GitHub API rate limit hit \(HTTP 403\)\. Remaining: 0\. Resets at: .*Set GITHUB_TOKEN/s,
    );
  });

  it("throws a rate-limit GitHubMetaError on 429, with 'unknown' when headers are absent", async () => {
    // 429 is transient under the transport policy — the stub answers the
    // retry identically, so the second failure surfaces after zero backoff.
    vi.stubGlobal("fetch", mockFetch(429, null));

    const err = (await fetchGitHubRepoMeta(OWNER, NAME, null, NO_DELAY).catch(
      (e: unknown) => e,
    )) as GitHubMetaError;

    expect(err).toBeInstanceOf(GitHubMetaError);
    expect(err.kind).toBe("rate_limited");
    expect(err.message).toMatch(
      /GitHub API rate limit hit \(HTTP 429\)\. Remaining: unknown\. Resets at: unknown/,
    );
  });

  it("retries a transient 500 once and succeeds when the retry recovers", async () => {
    const body = {
      full_name: "owner/repo",
      name: "repo",
      owner: { login: "owner" },
      default_branch: "main",
      description: null,
      stargazers_count: 0,
      open_issues_count: 0,
      homepage: null,
    };
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls++;
        return Promise.resolve(
          calls === 1 ? new Response(null, { status: 503 }) : Response.json(body),
        );
      }),
    );

    const result = await fetchGitHubRepoMeta(OWNER, NAME, null, NO_DELAY);

    expect(result.stargazers_count).toBe(0);
    expect(calls).toBe(2);
  });

  it("throws a generic error on other non-OK statuses after the single retry", async () => {
    vi.stubGlobal("fetch", mockFetch(500, null));

    await expect(fetchGitHubRepoMeta(OWNER, NAME, null, NO_DELAY)).rejects.toThrow(
      /GitHub API returned HTTP 500 for owner\/repo/,
    );
  });

  it("wraps a network-level failure in a descriptive error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNRESET"))),
    );

    await expect(fetchGitHubRepoMeta(OWNER, NAME, null, NO_DELAY)).rejects.toThrow(
      /Network error calling GitHub API for owner\/repo.*ECONNRESET/s,
    );
  });
});
