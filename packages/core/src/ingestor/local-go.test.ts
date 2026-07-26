/**
 * LocalGoIngestor unit tests
 *
 * Uses real temporary directories on disk (via node:fs/promises' mkdtemp)
 * rather than mocking node:fs — same rationale local-npm.test.ts already
 * documented: fs behavior (ENOENT vs. EISDIR, actual file presence) is more
 * faithfully exercised against the real filesystem than through a mock
 * that could silently drift from Node's actual contract.
 *
 * Dependency-parsing edge cases are already thoroughly covered directly in
 * go-parse.test.ts — these tests focus on what's actually new here:
 * reading from disk and detecting go.sum locally.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalGoIngestor } from "./local-go.js";

let repoDir: string;
let ingestor: LocalGoIngestor;

const SIMPLE_GO_MOD = `module example.com/x\n\ngo 1.22\n\nrequire (\n\tgithub.com/foo/bar v1.0.0\n)\n`;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "deptend-local-go-"));
  ingestor = new LocalGoIngestor();
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("LocalGoIngestor", () => {
  it("has the correct ecosystem property", () => {
    expect(ingestor.ecosystem).toBe("go");
  });

  it("parses dependencies from a real go.mod on disk", async () => {
    await writeFile(join(repoDir, "go.mod"), SIMPLE_GO_MOD);

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.ecosystem).toBe("go");
    expect(result.dependencies).toEqual([
      { package_name: "github.com/foo/bar", version_spec: "v1.0.0", dep_type: "production" },
    ]);
  });

  it("detects go.sum as a lock file", async () => {
    await writeFile(join(repoDir, "go.mod"), SIMPLE_GO_MOD);
    await writeFile(join(repoDir, "go.sum"), "");

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.lock_file_present).toBe(true);
    expect(result.warnings).not.toContainEqual(expect.stringContaining("No lock file detected"));
  });

  it("reports lock_file_present: false and a warning when go.sum doesn't exist", async () => {
    await writeFile(join(repoDir, "go.mod"), SIMPLE_GO_MOD);

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.lock_file_present).toBe(false);
    expect(result.warnings).toContainEqual(expect.stringContaining("No lock file detected"));
  });

  it("returns an empty result with a warning when go.mod doesn't exist", async () => {
    const result = await ingestor.parseDependencies(repoDir);

    expect(result.dependencies).toEqual([]);
    expect(result.lock_file_present).toBe(false);
    expect(result.manifest_resolved).toBe(false);
    expect(result.warnings).toContainEqual(expect.stringContaining("No go.mod found at"));
  });

  it("does not report lock_file_present when go.mod is missing, even if go.sum exists", async () => {
    // go.mod intentionally absent
    await writeFile(join(repoDir, "go.sum"), "");

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.lock_file_present).toBe(false);
  });

  it("throws a descriptive error for a filesystem error other than ENOENT", async () => {
    // A directory named go.mod triggers EISDIR on read, not ENOENT — same
    // portable trick local-npm.test.ts uses, avoiding chmod (which root can
    // bypass in some sandboxes).
    await mkdir(join(repoDir, "go.mod"));

    await expect(ingestor.parseDependencies(repoDir)).rejects.toThrow(/Failed to read/);
  });

  it("returns manifest_resolved: false when go.mod has no module directive", async () => {
    await writeFile(join(repoDir, "go.mod"), "not actually a go.mod\n");

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.dependencies).toEqual([]);
    expect(result.manifest_resolved).toBe(false);
    expect(result.warnings).toContainEqual(expect.stringContaining('No "module" directive'));
  });
});
