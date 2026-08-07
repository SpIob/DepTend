/**
 * checkSubmittableRepo unit tests
 *
 * Same vi.stubGlobal("fetch", ...) convention as github-meta.test.ts/
 * npm.test.ts — no real network calls. Deliberately tests this module's
 * own new logic only (error-reason categorization, rawBase construction,
 * the manifest_resolved -> no_manifest translation), not npm/pypi/go's
 * own parsing branches — those already have dedicated, much larger test
 * files of their own.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSubmittableRepo } from "./manifest-check.js";

const OWNER = "owner";
const NAME = "repo";

const REPO_META_BODY = {
  full_name: "owner/repo",
  name: "repo",
  owner: { login: "owner" },
  default_branch: "main",
  description: null,
  stargazers_count: 0,
  open_issues_count: 0,
  homepage: null,
};

/** Every raw.githubusercontent.com request (manifests + lock-file HEAD checks) 404s. */
function respondNotFoundToEverythingElse(url: string): Promise<Response> {
  return Promise.resolve(new Response(null, { status: 404, headers: { url } }));
}

describe("checkSubmittableRepo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves ok: true with the npm ecosystem when package.json exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.includes("api.github.com")) {
          return Promise.resolve(new Response(JSON.stringify(REPO_META_BODY), { status: 200 }));
        }
        if (url.endsWith("/package.json")) {
          return Promise.resolve(new Response("{}", { status: 200 }));
        }
        return respondNotFoundToEverythingElse(url);
      }),
    );

    const result = await checkSubmittableRepo(OWNER, NAME, null);

    expect(result).toEqual({ ok: true, ecosystem: "npm", meta: REPO_META_BODY });
  });

  it("builds the raw content base URL from the repo's actual default branch, not an assumed 'main'", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes("api.github.com")) {
          return Promise.resolve(
            new Response(JSON.stringify({ ...REPO_META_BODY, default_branch: "trunk" }), {
              status: 200,
            }),
          );
        }
        if (url.endsWith("/package.json")) {
          return Promise.resolve(new Response("{}", { status: 200 }));
        }
        return respondNotFoundToEverythingElse(url);
      }),
    );

    await checkSubmittableRepo(OWNER, NAME, null);

    expect(requestedUrls).toContain(
      `https://raw.githubusercontent.com/${OWNER}/${NAME}/trunk/package.json`,
    );
  });

  it("resolves ok: false, reason: no_manifest when nothing resolves for any ecosystem", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.includes("api.github.com")) {
          return Promise.resolve(new Response(JSON.stringify(REPO_META_BODY), { status: 200 }));
        }
        return respondNotFoundToEverythingElse(url);
      }),
    );

    const result = await checkSubmittableRepo(OWNER, NAME, null);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("no_manifest");
  });

  it("resolves ok: false, reason: not_found when the repo itself doesn't exist (or is private)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
    );

    const result = await checkSubmittableRepo(OWNER, NAME, null);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("not_found");
  });

  it("resolves ok: false, reason: rate_limited on a 403 from the GitHub REST API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 403 }))),
    );

    const result = await checkSubmittableRepo(OWNER, NAME, null);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("rate_limited");
  });

  it("resolves ok: false, reason: verification_failed on an unexpected error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("connection reset"))),
    );

    const result = await checkSubmittableRepo(OWNER, NAME, null);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("verification_failed");
  });
});
