import { describe, expect, it } from "vitest";
import { parsePullRequestUrl } from "./parse-pr-url.js";

describe("parsePullRequestUrl", () => {
  it("parses a plain https PR URL", () => {
    expect(parsePullRequestUrl("https://github.com/owner/repo/pull/42")).toEqual({
      url: "https://github.com/owner/repo/pull/42",
      owner: "owner",
      name: "repo",
      number: 42,
    });
  });

  it("accepts a trailing slash and normalizes it away", () => {
    expect(parsePullRequestUrl("https://github.com/owner/repo/pull/7/")?.url).toBe(
      "https://github.com/owner/repo/pull/7",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(parsePullRequestUrl("  https://github.com/o/r/pull/1  ")?.number).toBe(1);
  });

  it("accepts hyphenated, dotted, and underscored repo names", () => {
    expect(parsePullRequestUrl("https://github.com/some-owner/some.repo_name/pull/3")).toEqual({
      url: "https://github.com/some-owner/some.repo_name/pull/3",
      owner: "some-owner",
      name: "some.repo_name",
      number: 3,
    });
  });

  it("rejects non-github hosts", () => {
    expect(parsePullRequestUrl("https://gitlab.com/owner/repo/pull/1")).toBeNull();
    expect(parsePullRequestUrl("http://github.com/owner/repo/pull/1")).toBeNull();
  });

  it("rejects issue and non-pull paths", () => {
    expect(parsePullRequestUrl("https://github.com/owner/repo/issues/42")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/owner/repo")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/owner/repo/pull")).toBeNull();
  });

  it("rejects non-numeric and negative PR numbers", () => {
    expect(parsePullRequestUrl("https://github.com/owner/repo/pull/abc")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/owner/repo/pull/-1")).toBeNull();
  });

  it("rejects empty and garbage input", () => {
    expect(parsePullRequestUrl("")).toBeNull();
    expect(parsePullRequestUrl("not a url")).toBeNull();
  });
});
