/**
 * parseArgs unit tests
 *
 * Pins every flag-handling branch the live-network audit (2026-09-05)
 * showed the mocked suite missed (B1, B3, plus the negative-path matrix
 * rows in §2). Pairs with output.test.ts.
 */

import { describe, expect, it } from "vitest";
import { parseArgs } from "./index.js";

describe("parseArgs", () => {
  it("returns null for --help, so the caller prints USAGE and exits 0", () => {
    expect(parseArgs(["--help"])).toBeNull();
    expect(parseArgs(["-h"])).toBeNull();
  });

  it("throws when <repo-path> is missing", () => {
    expect(() => parseArgs(["--github-url", "https://github.com/owner/repo"])).toThrow(
      /Missing required <repo-path>/,
    );
  });

  it("throws when --github-url is missing", () => {
    expect(() => parseArgs(["."])).toThrow(/Missing required --github-url/);
  });

  it("captures the repo path from the first positional argument", () => {
    const result = parseArgs(["/tmp/myrepo", "--github-url", "https://github.com/owner/repo"]);
    expect(result?.repoPath).toBe("/tmp/myrepo");
    expect(result?.githubUrl).toBe("https://github.com/owner/repo");
  });

  it("throws when --output is passed with no value (B1)", () => {
    expect(() =>
      parseArgs([".", "--github-url", "https://github.com/owner/repo", "--output"]),
    ).toThrow(/--output requires a file path argument/);
  });

  it("throws when --output's value looks like another flag (B1)", () => {
    expect(() =>
      parseArgs([".", "--github-url", "https://github.com/owner/repo", "--output", "--json"]),
    ).toThrow(/--output requires a file path argument/);
  });

  it("throws when --github-url is passed with no value", () => {
    expect(() => parseArgs([".", "--github-url"])).toThrow(/--github-url requires a URL argument/);
  });

  it("throws on duplicate --output (B3)", () => {
    expect(() =>
      parseArgs([
        ".",
        "--github-url",
        "https://github.com/owner/repo",
        "--output",
        "/tmp/a.json",
        "--output",
        "/tmp/b.json",
      ]),
    ).toThrow(/Duplicate flag: --output/);
  });

  it("throws on duplicate --github-url", () => {
    expect(() =>
      parseArgs([
        ".",
        "--github-url",
        "https://github.com/owner/repo",
        "--github-url",
        "https://github.com/owner2/repo2",
      ]),
    ).toThrow(/Duplicate flag: --github-url/);
  });

  it("throws on unknown flag", () => {
    expect(() =>
      parseArgs([".", "--github-url", "https://github.com/owner/repo", "--bogus-flag"]),
    ).toThrow(/Unrecognized argument: --bogus-flag/);
  });

  it("captures --json correctly", () => {
    const result = parseArgs([".", "--github-url", "https://github.com/owner/repo", "--json"]);
    expect(result?.json).toBe(true);
  });

  it("defaults --json to false when not present", () => {
    const result = parseArgs([".", "--github-url", "https://github.com/owner/repo"]);
    expect(result?.json).toBe(false);
  });

  it("captures --output correctly", () => {
    const result = parseArgs([
      ".",
      "--github-url",
      "https://github.com/owner/repo",
      "--output",
      "/tmp/x.json",
    ]);
    expect(result?.outputPath).toBe("/tmp/x.json");
  });
});
