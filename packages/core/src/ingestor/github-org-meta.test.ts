/**
 * lookupGitHubOwnerMeta unit tests
 *
 * Mirrors github-meta.test.ts: vi.stubGlobal("fetch", …) so no network
 * calls are made, and the classifier's 404 fall-through is exercised
 * end-to-end (one stubbed fetch that responds 404, then 200, in order).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupGitHubOwnerMeta, GitHubOrgMetaError } from "./github-org-meta.js";

const LOGIN = "octocat";
const NO_DELAY = { retryDelayMs: 0, timeoutMs: 0 } as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("lookupGitHubOwnerMeta", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns org metadata when /orgs/{login} responds 200", async () => {
    const body = {
      login: LOGIN,
      name: "Octo Org",
      avatar_url: "https://example.com/avatar.png",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, body))),
    );

    const result = await lookupGitHubOwnerMeta(LOGIN, null, NO_DELAY);

    expect(result).toEqual({
      login: LOGIN,
      name: "Octo Org",
      avatarUrl: "https://example.com/avatar.png",
      isOrg: true,
    });
  });

  it("falls back to /users/{login} when /orgs/{login} responds 404 (personal account)", async () => {
    const userBody = {
      login: LOGIN,
      name: "Octocat",
      avatar_url: "https://example.com/avatar-user.png",
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(404, { message: "Not Found" }))
      .mockResolvedValueOnce(jsonResponse(200, userBody));
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookupGitHubOwnerMeta(LOGIN, null, NO_DELAY);

    expect(result).toEqual({
      login: LOGIN,
      name: "Octocat",
      avatarUrl: "https://example.com/avatar-user.png",
      isOrg: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.github.com/orgs/${LOGIN}`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`https://api.github.com/users/${LOGIN}`);
  });

  it("throws GitHubOrgMetaError(kind=not_found) when both /orgs and /users 404", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(404, { message: "Not Found" }))
      .mockResolvedValueOnce(jsonResponse(404, { message: "Not Found" }));
    vi.stubGlobal("fetch", fetchMock);

    const err = await lookupGitHubOwnerMeta(LOGIN, null, NO_DELAY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubOrgMetaError);
    expect((err as GitHubOrgMetaError).kind).toBe("not_found");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws GitHubOrgMetaError(kind=rate_limited) when /orgs hits 403 with Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ message: "rate limit" }), {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1700000000",
            },
          }),
        ),
      ),
    );

    const err = await lookupGitHubOwnerMeta(LOGIN, null, NO_DELAY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubOrgMetaError);
    expect((err as GitHubOrgMetaError).kind).toBe("rate_limited");
  });

  it("uses a Bearer Authorization header when a token is provided", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string> | undefined;
        return Promise.resolve(
          jsonResponse(200, {
            login: LOGIN,
            name: "Octo Org",
            avatar_url: "https://example.com/avatar.png",
          }),
        );
      }),
    );

    await lookupGitHubOwnerMeta(LOGIN, "test-token-123", NO_DELAY);

    expect(capturedHeaders?.Authorization).toBe("Bearer test-token-123");
  });

  it("omits the Authorization header when no token is provided", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string> | undefined;
        return Promise.resolve(
          jsonResponse(200, {
            login: LOGIN,
            name: "Octo Org",
            avatar_url: "https://example.com/avatar.png",
          }),
        );
      }),
    );

    await lookupGitHubOwnerMeta(LOGIN, null, NO_DELAY);

    expect(capturedHeaders?.Authorization).toBeUndefined();
  });

  it("URL-encodes the login in the request path", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse(200, {
          login: "sp iob",
          name: "Sp Iob",
          avatar_url: "https://example.com/avatar.png",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await lookupGitHubOwnerMeta("sp iob", null, NO_DELAY);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/orgs/sp%20iob",
      expect.anything(),
    );
  });

  it("propagates a non-404 /orgs error (e.g. 500) without falling back to /users", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(500, { message: "server error" }));
    vi.stubGlobal("fetch", fetchMock);

    // For a 5xx, the classifier returns undefined and fetchJson throws
    // its default Error("fetchJson — HTTP 500: ..."). The lookup function
    // re-throws the classifier's output (or, with no classifier match, the
    // raw fetchJson Error) — preserving the original HTTP status info
    // instead of wrapping it in a less-informative prefix. fetch-retry
    // itself retries 5xx once, so the mock sees 2 calls (initial + retry),
    // not 1.
    const err = await lookupGitHubOwnerMeta(LOGIN, null, NO_DELAY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/HTTP 500/);
    // /users never queried for a 5xx on /orgs.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.github.com/orgs/${LOGIN}`);
  });
});
