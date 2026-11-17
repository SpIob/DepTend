/**
 * parseArgs unit tests
 *
 * Pins every flag-handling branch the live-network audit (2026-09-05)
 * showed the mocked suite missed (B1, B3, plus the negative-path matrix
 * rows in §2). Pairs with output.test.ts.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isEntryPoint, parseArgs } from "./index.js";

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

  it("throws when --github-url is missing AND no repo path", () => {
    expect(() => parseArgs([])).toThrow(/Missing required <repo-path>/);
  });

  it("captures the repo path from the first positional argument", () => {
    const result = parseArgs(["/tmp/myrepo", "--github-url", "https://github.com/owner/repo"]);
    expect(result?.repoPath).toBe("/tmp/myrepo");
    expect(result?.githubUrl).toBe("https://github.com/owner/repo");
  });

  it("allows --github-url to be omitted (returns null for githubUrl)", () => {
    const result = parseArgs(["/tmp/myrepo"]);
    expect(result?.repoPath).toBe("/tmp/myrepo");
    expect(result?.githubUrl).toBeNull();
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

  it("captures --fail-on correctly", () => {
    const result = parseArgs([
      ".",
      "--github-url",
      "https://github.com/owner/repo",
      "--fail-on",
      "high",
    ]);
    expect(result?.failOn).toBe("high");
  });

  it("throws on invalid --fail-on level", () => {
    expect(() =>
      parseArgs([".", "--github-url", "https://github.com/owner/repo", "--fail-on", "invalid"]),
    ).toThrow(/Invalid --fail-on level/);
  });

  it("throws when --fail-on is passed with no value", () => {
    expect(() =>
      parseArgs([".", "--github-url", "https://github.com/owner/repo", "--fail-on"]),
    ).toThrow(/--fail-on requires a level argument/);
  });

  it("captures --fail-on-count correctly", () => {
    const result = parseArgs([
      ".",
      "--github-url",
      "https://github.com/owner/repo",
      "--fail-on-count",
      "5",
    ]);
    expect(result?.failOnCount).toBe(5);
  });

  it("throws on invalid --fail-on-count (non-integer)", () => {
    expect(() =>
      parseArgs([".", "--github-url", "https://github.com/owner/repo", "--fail-on-count", "abc"]),
    ).toThrow(/--fail-on-count requires a non-negative integer/);
  });

  it("throws on invalid --fail-on-count (negative)", () => {
    expect(() =>
      parseArgs([".", "--github-url", "https://github.com/owner/repo", "--fail-on-count", "-1"]),
    ).toThrow(/--fail-on-count requires a non-negative integer/);
  });

  it("throws when --fail-on-count is passed with no value", () => {
    expect(() =>
      parseArgs([".", "--github-url", "https://github.com/owner/repo", "--fail-on-count"]),
    ).toThrow(/--fail-on-count requires a number argument/);
  });

  it("allows both --fail-on and --fail-on-count together", () => {
    const result = parseArgs([
      ".",
      "--github-url",
      "https://github.com/owner/repo",
      "--fail-on",
      "medium",
      "--fail-on-count",
      "10",
    ]);
    expect(result?.failOn).toBe("medium");
    expect(result?.failOnCount).toBe(10);
  });

  it("throws on duplicate --fail-on", () => {
    expect(() =>
      parseArgs([
        ".",
        "--github-url",
        "https://github.com/owner/repo",
        "--fail-on",
        "high",
        "--fail-on",
        "low",
      ]),
    ).toThrow(/Duplicate flag: --fail-on/);
  });

  it("throws on duplicate --fail-on-count", () => {
    expect(() =>
      parseArgs([
        ".",
        "--github-url",
        "https://github.com/owner/repo",
        "--fail-on-count",
        "5",
        "--fail-on-count",
        "10",
      ]),
    ).toThrow(/Duplicate flag: --fail-on-count/);
  });

  it("defaults failOn and failOnCount to null when not present", () => {
    const result = parseArgs([".", "--github-url", "https://github.com/owner/repo"]);
    expect(result?.failOn).toBeNull();
    expect(result?.failOnCount).toBeNull();
  });

  it("captures --format correctly", () => {
    const result = parseArgs([
      ".",
      "--github-url",
      "https://github.com/owner/repo",
      "--format",
      "sarif",
    ]);
    expect(result?.format).toBe("sarif");
  });

  it("defaults --format to human when not present", () => {
    const result = parseArgs([".", "--github-url", "https://github.com/owner/repo"]);
    expect(result?.format).toBe("human");
  });

  it("throws on invalid --format", () => {
    expect(() =>
      parseArgs([".", "--github-url", "https://github.com/owner/repo", "--format", "invalid"]),
    ).toThrow(/Invalid --format/);
  });

  it("throws when --format is passed with no value", () => {
    expect(() =>
      parseArgs([".", "--github-url", "https://github.com/owner/repo", "--format"]),
    ).toThrow(/--format requires a format argument/);
  });

  it("throws on duplicate --format", () => {
    expect(() =>
      parseArgs([
        ".",
        "--github-url",
        "https://github.com/owner/repo",
        "--format",
        "sarif",
        "--format",
        "markdown",
      ]),
    ).toThrow(/Duplicate flag: --format/);
  });
});

describe("isEntryPoint (ADR 0067)", () => {
  // A real temp-dir fixture, not mocked paths: the 0.1.0 defect only exists
  // when process.argv[1] and the entry module are physically different paths
  // joined by a symlink — exactly what npm creates for an installed package
  // (node_modules/.bin/deptend → ../@deptend/cli/dist/index.js). The symlink
  // case below fails against the 0.1.0 gate (raw string comparison) and
  // passes against the fix (realpath-resolved comparison), verified both ways.
  const fixture = mkdtempSync(join(tmpdir(), "deptend-entry-gate-"));
  const modulePath = join(fixture, "dist-index.js");
  const binLinkPath = join(fixture, ".bin-deptend");
  writeFileSync(modulePath, "export {};\n");
  symlinkSync(modulePath, binLinkPath);
  const moduleUrl = pathToFileURL(modulePath).href;

  it("returns true when reached through the bin symlink (the 0.1.0 regression)", () => {
    expect(isEntryPoint(binLinkPath, moduleUrl)).toBe(true);
  });

  it("returns true when invoked directly by its real path (node dist/index.js)", () => {
    expect(isEntryPoint(modulePath, moduleUrl)).toBe(true);
  });

  it("returns false when there is no entry path (module imported, not run)", () => {
    expect(isEntryPoint(undefined, moduleUrl)).toBe(false);
  });

  it("returns false for a different existing file", () => {
    const otherPath = join(fixture, "unrelated.js");
    writeFileSync(otherPath, "export {};\n");
    expect(isEntryPoint(otherPath, moduleUrl)).toBe(false);
  });

  it("returns false — without throwing — for a path that cannot be resolved", () => {
    expect(isEntryPoint(join(fixture, "does-not-exist.js"), moduleUrl)).toBe(false);
  });

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true });
  });
});
