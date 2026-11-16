/**
 * parse-github-url.ts unit tests
 *
 * Pure input-shape coverage for parseGithubUrl(). Moved here from
 * db/repos.test.ts alongside the implementation, which left the data layer so
 * that importing the parser stops pulling drizzle-orm into consumers' module
 * graphs (ADR 0066).
 */

import { describe, expect, it } from "vitest";
import { parseGithubUrl } from "./parse-github-url.js";

// ---------------------------------------------------------------------------
// parseGithubUrl
// ---------------------------------------------------------------------------

describe("parseGithubUrl", () => {
  it.each([
    "https://github.com/owner/repo",
    "http://github.com/owner/repo",
    "github.com/owner/repo",
    "https://www.github.com/owner/repo",
    "https://github.com/owner/repo/",
    "https://github.com/owner/repo.git",
    "www.github.com/owner/repo.git/",
  ])("accepts %s and normalizes it to https://github.com/owner/repo", (input) => {
    expect(parseGithubUrl(input)).toEqual({
      githubUrl: "https://github.com/owner/repo",
      owner: "owner",
      name: "repo",
    });
  });

  it("trims leading/trailing whitespace before parsing", () => {
    expect(parseGithubUrl("  https://github.com/owner/repo  ")).toEqual({
      githubUrl: "https://github.com/owner/repo",
      owner: "owner",
      name: "repo",
    });
  });

  it("accepts owner/repo names with hyphens, underscores, dots, and digits", () => {
    expect(parseGithubUrl("https://github.com/my-org2/my_repo.js")).toEqual({
      githubUrl: "https://github.com/my-org2/my_repo.js",
      owner: "my-org2",
      name: "my_repo.js",
    });
  });

  it("accepts single-character owner and repo names", () => {
    expect(parseGithubUrl("https://github.com/a/b")).toEqual({
      githubUrl: "https://github.com/a/b",
      owner: "a",
      name: "b",
    });
  });

  it.each([
    ["https://gitlab.com/owner/repo", "non-GitHub host (gitlab.com)"],
    ["https://bitbucket.org/owner/repo", "non-GitHub host (bitbucket.org)"],
    [
      "https://raw.githubusercontent.com/owner/repo/main/x",
      "GitHub subdomain, not github.com itself",
    ],
    ["https://github.com/owner", "missing repo name"],
    ["https://github.com/", "missing owner and repo"],
    ["", "empty string"],
    ["   ", "whitespace only"],
    ["not a url at all", "garbage input"],
    ["https://github.com/-owner/repo", "owner starting with a hyphen"],
    ["https://github.com/owner-/repo", "owner ending with a hyphen"],
  ])("rejects %s (%s)", (input) => {
    expect(parseGithubUrl(input)).toBeNull();
  });
});
