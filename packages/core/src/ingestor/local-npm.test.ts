/**
 * LocalNpmIngestor unit tests
 *
 * Uses real temporary directories on disk (via node:fs/promises' mkdtemp)
 * rather than mocking node:fs — fs behavior (ENOENT vs. EISDIR, actual file
 * presence) is more faithfully exercised against the real filesystem than
 * through a mock that could silently drift from Node's actual contract
 * (the same class of risk ADR 0010 flagged for OSV's mocked response shape).
 *
 * Dependency-section parsing itself (invalid names, malformed sections,
 * etc.) is already thoroughly covered by npm.test.ts via the shared
 * parsePackageJsonContent — these tests focus on what's actually new here:
 * reading from disk and detecting lock files locally.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalNpmIngestor } from "./local-npm.js";

let repoDir: string;
let ingestor: LocalNpmIngestor;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "deptend-local-npm-"));
  ingestor = new LocalNpmIngestor();
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("LocalNpmIngestor", () => {
  it("has the correct ecosystem property", () => {
    expect(ingestor.ecosystem).toBe("npm");
  });

  it("parses dependencies from a real package.json on disk", async () => {
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({
        dependencies: { react: "^18.0.0" },
        devDependencies: { vitest: "^2.0.0" },
      }),
    );

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.ecosystem).toBe("npm");
    expect(result.dependencies).toEqual(
      expect.arrayContaining([
        { package_name: "react", version_spec: "^18.0.0", dep_type: "production" },
        { package_name: "vitest", version_spec: "^2.0.0", dep_type: "development" },
      ]),
    );
    expect(result.dependencies).toHaveLength(2);
  });

  it("reports lock_file_present: false and a warning when no lock file exists", async () => {
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ dependencies: { lodash: "^4.0.0" } }),
    );

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.lock_file_present).toBe(false);
    expect(result.warnings).toContainEqual(expect.stringContaining("No lock file detected"));
  });

  it.each(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"])(
    "detects %s as a lock file",
    async (lockFileName) => {
      await writeFile(join(repoDir, "package.json"), JSON.stringify({ dependencies: {} }));
      await writeFile(join(repoDir, lockFileName), "");

      const result = await ingestor.parseDependencies(repoDir);

      expect(result.lock_file_present).toBe(true);
      expect(result.warnings).not.toContainEqual(expect.stringContaining("No lock file detected"));
    },
  );

  it("returns an empty result with a warning when package.json doesn't exist", async () => {
    const result = await ingestor.parseDependencies(repoDir);

    expect(result.dependencies).toEqual([]);
    expect(result.lock_file_present).toBe(false);
    expect(result.warnings).toContainEqual(expect.stringContaining("No package.json found at"));
  });

  it("does not report lock_file_present when package.json is missing, even if a lock file exists", async () => {
    // package.json intentionally absent
    await writeFile(join(repoDir, "package-lock.json"), "");

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.lock_file_present).toBe(false);
  });

  it("throws a descriptive error for a filesystem error other than ENOENT", async () => {
    // A directory named package.json triggers EISDIR on read, not ENOENT —
    // a portable way to exercise the "unexpected fs error" path without
    // relying on chmod (which root can bypass in some sandboxes).
    await mkdir(join(repoDir, "package.json"));

    await expect(ingestor.parseDependencies(repoDir)).rejects.toThrow(/Failed to read/);
  });

  it("returns an empty result with a warning when package.json is not valid JSON", async () => {
    await writeFile(join(repoDir, "package.json"), "{ not valid json");

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.dependencies).toEqual([]);
    expect(result.warnings).toContainEqual(expect.stringContaining("is not valid JSON"));
  });
});
