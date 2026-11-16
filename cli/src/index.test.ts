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
