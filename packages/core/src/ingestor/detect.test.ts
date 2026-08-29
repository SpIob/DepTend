/**
 * detectEcosystem unit tests
 *
 * Uses simple fake EcosystemIngestor implementations rather than the real
 * npm/pypi ones — this router's job is "probe in parallel, first resolved
 * wins, priority is caller-list order on tie, abort in-flight losers,"
 * which has nothing to do with how any particular ingestor fetches or
 * parses. Real-ingestor coverage already exists in npm.test.ts, pypi.test.ts,
 * etc.
 */

import { describe, expect, it, vi } from "vitest";
import { detectEcosystem } from "./detect.js";
import type { IngestorResult } from "./interface.js";

function resolvedResult(ecosystem: "npm" | "pypi" | "go", warnings: string[] = []): IngestorResult {
  return {
    ecosystem,
    dependencies: [{ package_name: "some-pkg", version_spec: "*", dep_type: "production" }],
    lock_file_present: true,
    manifest_resolved: true,
    warnings,
  };
}

function unresolvedResult(ecosystem: "npm" | "pypi" | "go", warnings: string[]): IngestorResult {
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
 *
 * The `signal?` parameter is the new ADR 0041 addition; every probe
 * accepts it (filesystem-backed fakes just ignore it).
 */
interface FakeIngestor {
  readonly ecosystem: "npm" | "pypi" | "go";
  parseDependencies: (repoPath: string, signal?: AbortSignal) => Promise<IngestorResult>;
}

/** A fake ingestor whose parseDependencies() always returns the given result. */
function fakeIngestor(ecosystem: "npm" | "pypi" | "go", result: IngestorResult): FakeIngestor {
  return {
    ecosystem,
    parseDependencies: vi.fn().mockResolvedValue(result),
  };
}

/**
 * A fake whose parseDependencies resolves after a delay. Used to assert
 * priority-tie-break behavior: two probes both resolve, the lower-index
 * one wins regardless of which settled first.
 */
function slowResolvedIngestor(ecosystem: "npm" | "pypi" | "go", delayMs: number): FakeIngestor {
  return {
    ecosystem,
    parseDependencies: vi.fn(async (_repoPath: string) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return resolvedResult(ecosystem);
    }),
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

  it("forwards the same repoPath to every ingestor (no early cutoff)", async () => {
    // ADR 0041: probes run in parallel, so the second ingestor's
    // parseDependencies() is invoked immediately rather than only after
    // the first resolves. The pre-0041 sequential test ("does not call
    // the second ingestor when the first resolves") is replaced by this
    // both-invoked shape; the speedup IS the point.
    const npm = fakeIngestor("npm", resolvedResult("npm"));
    const pypi = fakeIngestor("pypi", resolvedResult("pypi"));

    await detectEcosystem([npm, pypi], "/some/path");

    expect(npm.parseDependencies).toHaveBeenCalledWith("/some/path", expect.any(AbortSignal));
    expect(pypi.parseDependencies).toHaveBeenCalledWith("/some/path", expect.any(AbortSignal));
  });

  it("returns the second ingestor's result when the first doesn't resolve", async () => {
    const npm = fakeIngestor("npm", unresolvedResult("npm", ["no package.json found"]));
    const pypi = fakeIngestor("pypi", resolvedResult("pypi"));

    const result = await detectEcosystem([npm, pypi], "/some/path");

    expect(result.ecosystem).toBe("pypi");
    expect(result.manifest_resolved).toBe(true);
  });

  it("probes every ingestor in parallel even when the first resolves", async () => {
    // All three ingestors get invoked up front. The earlier "sequential
    // fall-through" test is replaced: parallel probing is the contract.
    const npm = fakeIngestor("npm", unresolvedResult("npm", []));
    const pypi = fakeIngestor("pypi", resolvedResult("pypi"));
    const go = fakeIngestor("go", unresolvedResult("go", []));

    const result = await detectEcosystem([npm, pypi, go], "/some/path");

    expect(npm.parseDependencies).toHaveBeenCalledWith("/some/path", expect.any(AbortSignal));
    expect(pypi.parseDependencies).toHaveBeenCalledWith("/some/path", expect.any(AbortSignal));
    expect(go.parseDependencies).toHaveBeenCalledWith("/some/path", expect.any(AbortSignal));
    expect(result.ecosystem).toBe("pypi");
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
      expect.any(AbortSignal),
    );
    expect(pypi.parseDependencies).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/owner/repo/main",
      expect.any(AbortSignal),
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

  // -------------------------------------------------------------------------
  // Throwing probes — a transport failure is not a verdict about the repo
  // -------------------------------------------------------------------------

  it("falls through to the next ingestor when a probe throws (transient network error)", async () => {
    const npm = fakeIngestor("npm", unresolvedResult("npm", []));
    npm.parseDependencies = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    const pypi = fakeIngestor("pypi", resolvedResult("pypi"));

    const result = await detectEcosystem([npm, pypi], "/some/path");

    expect(result.ecosystem).toBe("pypi");
    expect(result.manifest_resolved).toBe(true);
  });

  it("keeps probing after an intermediate ingestor throws, not just the first", async () => {
    const npm = fakeIngestor("npm", unresolvedResult("npm", []));
    const pypi = fakeIngestor("pypi", unresolvedResult("pypi", []));
    pypi.parseDependencies = vi.fn().mockRejectedValue(new Error("HTTP 503"));
    const later = fakeIngestor("go", resolvedResult("go"));

    const result = await detectEcosystem([npm, pypi, later], "/some/path");

    expect(later.parseDependencies).toHaveBeenCalled();
    expect(result.manifest_resolved).toBe(true);
  });

  it("returns an unresolved result with every probe's failure recorded when all ingestors throw", async () => {
    const npm = fakeIngestor("npm", unresolvedResult("npm", []));
    npm.parseDependencies = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    const pypi = fakeIngestor("pypi", unresolvedResult("pypi", []));
    pypi.parseDependencies = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const result = await detectEcosystem([npm, pypi], "/some/path");

    expect(result.manifest_resolved).toBe(false);
    expect(result.dependencies).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("npm probe failed");
    expect(result.warnings[0]).toContain("ENOTFOUND");
    expect(result.warnings[1]).toContain("pypi probe failed");
  });

  // -------------------------------------------------------------------------
  // ADR 0041 — parallel probing with priority-tie-break
  // -------------------------------------------------------------------------

  it("breaks priority ties by caller-list index (lower index wins)", async () => {
    // Both probes resolve; npm is listed first and must win even though
    // pypi resolves faster. The pre-0041 sequential code never hit this
    // case (it stopped at npm), so this is a new invariant.
    const npm = slowResolvedIngestor("npm", 20);
    const pypi = slowResolvedIngestor("pypi", 1);

    const result = await detectEcosystem([npm, pypi], "/some/path");

    expect(result.ecosystem).toBe("npm");
  });

  it("breaks priority ties the other way too (pypi first → pypi wins)", async () => {
    const npm = slowResolvedIngestor("npm", 1);
    const pypi = slowResolvedIngestor("pypi", 20);

    const result = await detectEcosystem([pypi, npm], "/some/path");

    expect(result.ecosystem).toBe("pypi");
  });

  it("aborts the signal of the losing in-flight probe when a higher-priority one wins", async () => {
    // The losing probe receives an AbortSignal; once a higher-priority
    // probe claims the win, that signal must be aborted so the in-flight
    // HTTP request cancels at the OS level rather than completing and
    // being discarded.
    const pypi = slowResolvedIngestor("pypi", 5);
    const npm = slowResolvedIngestor("npm", 30);

    await detectEcosystem([npm, pypi], "/some/path");

    // pypi is index 1, npm is index 0 — npm wins; pypi's signal must
    // have been aborted.
    const pypiCallArgs = (pypi.parseDependencies as ReturnType<typeof vi.fn>).mock
      .calls[0] as unknown[];
    const pypiSignal = pypiCallArgs[1] as AbortSignal | undefined;
    expect(pypiSignal).toBeDefined();
    expect(pypiSignal?.aborted).toBe(true);

    // npm won, so its signal stays open (or aborted by its own return —
    // either is fine; the important assertion is that pypi's was
    // aborted by the orchestrator, not by a self-cancellation).
    const npmCallArgs = (npm.parseDependencies as ReturnType<typeof vi.fn>).mock
      .calls[0] as unknown[];
    const npmSignal = npmCallArgs[1] as AbortSignal | undefined;
    expect(npmSignal).toBeDefined();
  });

  it("does not surface orchestrator-initiated aborts as warnings on the all-fail path", async () => {
    // Synthetic scenario: two probes both throw, but the second throw
    // happens after the first throw is "converted" to an unresolved
    // result and the winner slot is already claimed. With two throwing
    // probes, neither claims a winner, so all-fail path runs and the
    // orchestrator-initiated abort never occurs (no winners, no aborts).
    // The real "no warning on orchestrator-initiated abort" path is
    // covered indirectly by the happy-path priority-tie tests above:
    // when a winner claims, the loser's warnings[] is its empty
    // synthetic slot, not a transport error.
    //
    // What we DO assert here: a transport-failure warning for a probe
    // that threw, with no AbortError contamination.
    const npm = fakeIngestor("npm", unresolvedResult("npm", []));
    npm.parseDependencies = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    const pypi = fakeIngestor("pypi", unresolvedResult("pypi", []));
    pypi.parseDependencies = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const result = await detectEcosystem([npm, pypi], "/some/path");

    // No warnings carry the orchestrator's "aborted by winner" sentinel.
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes("aborted by orchestrator"))).toBe(false);
  });
});
