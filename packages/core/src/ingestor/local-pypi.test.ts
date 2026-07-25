/**
 * LocalPyPIIngestor unit tests
 *
 * Uses real temporary directories on disk (via node:fs/promises' mkdtemp)
 * rather than mocking node:fs — same reasoning as local-npm.test.ts: fs
 * behavior is more faithfully exercised against the real filesystem than
 * through a mock that could silently drift from Node's actual contract.
 *
 * Dependency-parsing edge cases are already thoroughly covered directly in
 * pypi-parse.test.ts via the shared parsePyPIManifests — these tests focus
 * on what's actually new here: reading two manifest files from disk and
 * detecting lock files locally.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalPyPIIngestor } from "./local-pypi.js";

let repoDir: string;
let ingestor: LocalPyPIIngestor;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "deptend-local-pypi-"));
  ingestor = new LocalPyPIIngestor();
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("LocalPyPIIngestor", () => {
  it("has the correct ecosystem property", () => {
    expect(ingestor.ecosystem).toBe("pypi");
  });

  it("parses dependencies from a real pyproject.toml on disk", async () => {
    await writeFile(
      join(repoDir, "pyproject.toml"),
      `[project]\ndependencies = ["requests>=2.25"]\n`,
    );

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.ecosystem).toBe("pypi");
    expect(result.dependencies).toEqual([
      { package_name: "requests", version_spec: ">=2.25", dep_type: "production" },
    ]);
  });

  it("falls back to a real requirements.txt on disk when pyproject.toml doesn't exist", async () => {
    await writeFile(join(repoDir, "requirements.txt"), "click==8.1.0\n");

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.manifest_resolved).toBe(true);
    expect(result.dependencies).toEqual([
      { package_name: "click", version_spec: "==8.1.0", dep_type: "production" },
    ]);
  });

  it("reports lock_file_present: false and a warning when no lock file exists", async () => {
    await writeFile(join(repoDir, "pyproject.toml"), `[project]\ndependencies = []\n`);

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.lock_file_present).toBe(false);
    expect(result.warnings).toContainEqual(expect.stringContaining("No lock file detected"));
  });

  it.each(["poetry.lock", "Pipfile.lock", "pdm.lock"])(
    "detects %s as a lock file",
    async (lockFileName) => {
      await writeFile(join(repoDir, "pyproject.toml"), `[project]\ndependencies = []\n`);
      await writeFile(join(repoDir, lockFileName), "");

      const result = await ingestor.parseDependencies(repoDir);

      expect(result.lock_file_present).toBe(true);
      expect(result.warnings).not.toContainEqual(expect.stringContaining("No lock file detected"));
    },
  );

  it("returns an empty result with a warning when neither manifest exists", async () => {
    const result = await ingestor.parseDependencies(repoDir);

    expect(result.dependencies).toEqual([]);
    expect(result.manifest_resolved).toBe(false);
    expect(result.lock_file_present).toBe(false);
    expect(result.warnings).toContainEqual(expect.stringContaining("Repository skipped"));
  });

  it("does not report lock_file_present when neither manifest exists, even if a lock file exists", async () => {
    // Neither pyproject.toml nor requirements.txt present
    await writeFile(join(repoDir, "poetry.lock"), "");

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.lock_file_present).toBe(false);
  });

  it("throws a descriptive error for a filesystem error other than ENOENT", async () => {
    // A directory named pyproject.toml triggers EISDIR on read, not ENOENT
    await mkdir(join(repoDir, "pyproject.toml"));

    await expect(ingestor.parseDependencies(repoDir)).rejects.toThrow(/Failed to read/);
  });

  it("falls back to requirements.txt when pyproject.toml on disk is not valid TOML", async () => {
    await writeFile(join(repoDir, "pyproject.toml"), "not [ valid toml");
    await writeFile(join(repoDir, "requirements.txt"), "requests==2.31.0\n");

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.manifest_resolved).toBe(true);
    expect(result.dependencies).toEqual([
      { package_name: "requests", version_spec: "==2.31.0", dep_type: "production" },
    ]);
    expect(result.warnings.some((w) => w.includes("not valid TOML"))).toBe(true);
  });
});
