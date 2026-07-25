/**
 * detectEcosystem unit tests
 *
 * Uses simple fake EcosystemIngestor implementations rather than the real
 * npm/pypi ones — this router's job is purely "try in order, stop at the
 * first resolved result, else combine warnings," which has nothing to do
 * with how any particular ingestor fetches or parses. Real-ingestor
 * coverage already exists in npm.test.ts, pypi.test.ts, etc.
 */

import { describe, expect, it, vi } from "vitest";
import { detectEcosystem } from "./detect.js";
import type { IngestorResult } from "./interface.js";

function resolvedResult(ecosystem: "npm" | "pypi", warnings: string[] = []): IngestorResult {
  return {
    ecosystem,
    dependencies: [{ package_name: "some-pkg", version_spec: "*", dep_type: "production" }],
    lock_file_present: true,
    manifest_resolved: true,
    warnings,
  };
}

function unresolvedResult(ecosystem: "npm" | "pypi", warnings: string[]): IngestorResult {
  return {
    ecosystem,
    dependencies: [],
    lock_file_present: false,
    manifest_resolved: false,
    warnings,
  };
}

/**
 * Same shape as EcosystemIngestor, but declared with property syntax
 * (`parseDependencies: (repoPath: string) => ...`) instead of method
 * shorthand (`parseDependencies(repoPath: string): ...`). Structurally
 * identical for assignability — TypeScript doesn't care about the
 * difference — but @typescript-eslint/unbound-method only objects to bare
 * `obj.method` access when the *declared* type uses method shorthand, so
 * this sidesteps needing vi.mocked() wrapping or eslint-disable comments
 * at every assertion below.
 */
interface FakeIngestor {
  readonly ecosystem: "npm" | "pypi";
  parseDependencies: (repoPath: string) => Promise<IngestorResult>;
}

/** A fake ingestor whose parseDependencies() always returns the given result. */
function fakeIngestor(ecosystem: "npm" | "pypi", result: IngestorResult): FakeIngestor {
  return {
    ecosystem,
    parseDependencies: vi.fn().mockResolvedValue(result),
  };
}

describe("detectEcosystem", () => {
  it("returns the first ingestor's result when it resolves", async () => {
    const npm = fakeIngestor("npm", resolvedResult("npm"));
    const pypi = fakeIngestor("pypi", resolvedResult("pypi"));

    const result = await detectEcosystem([npm, pypi], "/some/path");

    expect(result.ecosystem).toBe("npm");
    expect(result.manifest_resolved).toBe(true);
  });

  it("does not call the second ingestor when the first resolves", async () => {
    const npm = fakeIngestor("npm", resolvedResult("npm"));
    const pypi = fakeIngestor("pypi", resolvedResult("pypi"));

    await detectEcosystem([npm, pypi], "/some/path");

    expect(pypi.parseDependencies).not.toHaveBeenCalled();
  });

  it("falls through to the second ingestor when the first doesn't resolve", async () => {
    const npm = fakeIngestor("npm", unresolvedResult("npm", ["no package.json found"]));
    const pypi = fakeIngestor("pypi", resolvedResult("pypi"));

    const result = await detectEcosystem([npm, pypi], "/some/path");

    expect(result.ecosystem).toBe("pypi");
    expect(result.manifest_resolved).toBe(true);
  });

  it("calls every ingestor in order until one resolves", async () => {
    const npm = fakeIngestor("npm", unresolvedResult("npm", []));
    const pypi = fakeIngestor("pypi", resolvedResult("pypi"));

    await detectEcosystem([npm, pypi], "/some/path");

    expect(npm.parseDependencies).toHaveBeenCalledWith("/some/path");
    expect(pypi.parseDependencies).toHaveBeenCalledWith("/some/path");
  });

  it("returns an unresolved result with combined warnings when nothing resolves", async () => {
    const npm = fakeIngestor("npm", unresolvedResult("npm", ["no package.json found"]));
    const pypi = fakeIngestor(
      "pypi",
      unresolvedResult("pypi", ["no pyproject.toml or requirements.txt found"]),
    );

    const result = await detectEcosystem([npm, pypi], "/some/path");

    expect(result.manifest_resolved).toBe(false);
    expect(result.dependencies).toEqual([]);
    expect(result.warnings).toEqual([
      "no package.json found",
      "no pyproject.toml or requirements.txt found",
    ]);
  });

  it("preserves probing order in the combined warnings regardless of which ecosystem is listed last", async () => {
    // Same as above but reversed order, to confirm warning order tracks
    // probing order (array order), not some fixed ecosystem preference.
    const pypi = fakeIngestor("pypi", unresolvedResult("pypi", ["pypi warning"]));
    const npm = fakeIngestor("npm", unresolvedResult("npm", ["npm warning"]));

    const result = await detectEcosystem([pypi, npm], "/some/path");

    expect(result.warnings).toEqual(["pypi warning", "npm warning"]);
  });

  it("passes repoPath through to every ingestor unchanged", async () => {
    const npm = fakeIngestor("npm", unresolvedResult("npm", []));
    const pypi = fakeIngestor("pypi", unresolvedResult("pypi", []));

    await detectEcosystem([npm, pypi], "https://raw.githubusercontent.com/owner/repo/main");

    expect(npm.parseDependencies).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/owner/repo/main",
    );
    expect(pypi.parseDependencies).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/owner/repo/main",
    );
  });

  it("returns a safe empty result rather than throwing when given an empty ingestors list", async () => {
    const result = await detectEcosystem([], "/some/path");

    expect(result.manifest_resolved).toBe(false);
    expect(result.dependencies).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("works correctly with a single ingestor (no fallback needed)", async () => {
    const npm = fakeIngestor("npm", resolvedResult("npm"));

    const result = await detectEcosystem([npm], "/some/path");

    expect(result.ecosystem).toBe("npm");
    expect(result.manifest_resolved).toBe(true);
  });
});
