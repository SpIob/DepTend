/**
 * analyze() end-to-end test
 *
 * Mocks all three external fetch-based dependencies (GitHub API, OSV,
 * npm registry) behind a single URL router, since analyze() calls all
 * three in one run. Uses a real temp directory on disk for the
 * package.json side (LocalNpmIngestor), same rationale as
 * local-npm.test.ts — real fs behavior over a mocked one.
 *
 * Live network testing against the real OSV API isn't possible from every
 * environment (some sandboxes restrict egress to a domain allowlist that
 * doesn't include osv.dev) — this test exercises the exact same code path
 * without depending on any of the three services actually being reachable.
 */

import { describe, expect, it, vi } from "vitest";
import { analyze } from "./analyze.js";
import { setupTestRepo, createTestRepo } from "./test/helpers/test-repo.js";
import {
  createNpmFetchRouter,
  createPyPIFetchRouter,
  createGoFetchRouter,
  createTieBreakingFetchRouter,
  createBreakingChangeFetchRouter,
  createFetchRouter,
} from "./test/mocks/fetch-router.js";

describe("analyze", () => {
  it("produces a ranked mission list from a local repo with a real vulnerability", async () => {
    const repo = await setupTestRepo("npm", "vulnerable");
    vi.stubGlobal("fetch", await createNpmFetchRouter());

    const result = await analyze({
      repoPath: repo.path,
      githubOwner: "owner",
      githubName: "repo",
      githubToken: null,
    });

    await repo.cleanup();

    expect(result.repo.stars).toBe(100);
    expect(result.repo.owner).toBe("owner");
    expect(result.dependencies_scanned).toBe(1);
    expect(result.lock_file_present).toBe(false);

    expect(result.missions).toHaveLength(1);
    const mission = result.missions[0];
    expect(mission?.dependency.package_name).toBe("vulnerable-pkg");
    expect(mission?.advisory.osv_id).toBe("GHSA-test-1234");
    expect(mission?.advisory.severity).toBe("critical"); // CVSS 9.8 -> critical
    expect(mission?.advisory.fixed_version).toBe("1.0.1");
    expect(mission?.title).toContain("vulnerable-pkg");
    expect(mission?.composite_score).toBeGreaterThan(0);
    expect(mission?.confidence).toBe("low"); // no lock file + no downstream data, by design
  });

  it("produces a ranked mission list from a local PyPI repo with a real vulnerability (ADR 0022)", async () => {
    // No package.json anywhere in repoDir — only pyproject.toml — so the
    // router (npm tried first) falls through to PyPI. Also incidentally
    // exercises the ECOSYSTEM-range fix from osv.ts (Step 6) end-to-end
    // through the real CLI path, not just osv.test.ts's isolated mocks.
    const repo = await setupTestRepo("pypi", "vulnerable");
    vi.stubGlobal("fetch", await createPyPIFetchRouter());

    const result = await analyze({
      repoPath: repo.path,
      githubOwner: "owner",
      githubName: "repo",
      githubToken: null,
    });

    await repo.cleanup();

    expect(result.ecosystem).toBe("pypi");
    expect(result.dependencies_scanned).toBe(1);
    expect(result.lock_file_present).toBe(false);

    expect(result.missions).toHaveLength(1);
    const mission = result.missions[0];
    expect(mission?.dependency.package_name).toBe("vulnerable-pkg");
    expect(mission?.advisory.osv_id).toBe("GHSA-test-pypi-1234");
    expect(mission?.advisory.severity).toBe("critical");
    expect(mission?.advisory.fixed_version).toBe("1.0.1");
  });

  it("produces a ranked mission list from a local Go repo with a real vulnerability (ADR 0024)", async () => {
    // No package.json or pyproject.toml anywhere in repoDir — only go.mod —
    // so the router (npm, then PyPI, tried first) falls through to Go.
    const repo = await setupTestRepo("go", "vulnerable");
    vi.stubGlobal("fetch", await createGoFetchRouter());

    const result = await analyze({
      repoPath: repo.path,
      githubOwner: "owner",
      githubName: "repo",
      githubToken: null,
    });

    await repo.cleanup();

    expect(result.ecosystem).toBe("go");
    expect(result.dependencies_scanned).toBe(1);
    expect(result.lock_file_present).toBe(false);

    expect(result.missions).toHaveLength(1);
    const mission = result.missions[0];
    expect(mission?.dependency.package_name).toBe("github.com/vulnerable/pkg");
    expect(mission?.advisory.osv_id).toBe("GHSA-test-go-1234");
    expect(mission?.advisory.severity).toBe("critical");
    expect(mission?.advisory.fixed_version).toBe("v1.0.1");
  });

  it("produces no missions for a repo with no vulnerable dependencies", async () => {
    const repo = await setupTestRepo("npm", "clean");
    vi.stubGlobal(
      "fetch",
      await createFetchRouter({
        osvBatch: { results: [{}] },
        npmRegistry: { status: 404 },
      }),
    );

    const result = await analyze({
      repoPath: repo.path,
      githubOwner: "owner",
      githubName: "repo",
      githubToken: null,
    });

    await repo.cleanup();

    expect(result.missions).toEqual([]);
    expect(result.dependencies_scanned).toBe(1);
  });

  it("still returns repo metadata and warnings when there's no manifest for any ecosystem", async () => {
    // repoDir intentionally left empty — no package.json, no
    // pyproject.toml, no requirements.txt. The router (npm first, per ADR
    // 0022) tries both and falls through to fully unresolved.
    const repo = await createTestRepo();
    vi.stubGlobal("fetch", await createFetchRouter({}));

    const result = await analyze({
      repoPath: repo.path,
      githubOwner: "owner",
      githubName: "repo",
      githubToken: null,
    });

    await repo.cleanup();

    expect(result.dependencies_scanned).toBe(0);
    expect(result.missions).toEqual([]);
    // Both ingestors' own warnings should be present — confirms the router
    // actually tried both rather than stopping after npm's failure alone.
    expect(result.warnings).toContainEqual(expect.stringContaining("No package.json found at"));
    expect(result.warnings).toContainEqual(
      expect.stringContaining("No usable pyproject.toml or requirements.txt found"),
    );
  });

  it("breaks a tie between two equally-scored missions by published_at, newest first (ADR 0018)", async () => {
    const repo = await setupTestRepo("npm", "twoPackages");
    vi.stubGlobal("fetch", await createTieBreakingFetchRouter());

    const result = await analyze({
      repoPath: repo.path,
      githubOwner: "owner",
      githubName: "repo",
      githubToken: null,
    });

    await repo.cleanup();

    expect(result.missions).toHaveLength(2);
    expect(result.missions[0]?.composite_score).toBe(result.missions[1]?.composite_score);
    expect(result.missions[0]?.effort_label).toBe(result.missions[1]?.effort_label);
    // Genuinely tied on both — published_at decides it, newest first.
    expect(result.missions[0]?.advisory.osv_id).toBe("GHSA-newer-2222");
    expect(result.missions[1]?.advisory.osv_id).toBe("GHSA-older-1111");
  });

  it("resolves real breaking-change signals end-to-end and clears breaking_change_signals_unavailable (ADR 0029)", async () => {
    const repo = await setupTestRepo("npm", "vulnerable");
    vi.stubGlobal("fetch", await createBreakingChangeFetchRouter());

    const result = await analyze({
      repoPath: repo.path,
      githubOwner: "owner",
      githubName: "repo",
      githubToken: null,
    });

    await repo.cleanup();

    expect(result.missions).toHaveLength(1);
    const mission = result.missions[0];
    expect(mission?.scoring_inputs.effort.breaking_change_signals).toEqual([
      "removed the deprecated foo() export.",
    ]);
    expect(mission?.scoring_inputs.effort.has_migration_guide).toBe(false);
    expect(mission?.confidence_notes).not.toContain(
      "Changelog and migration-guide data wasn't available for this dependency's own upstream repository, so the effort estimate is based on the semver version bump alone.",
    );
    // confidence itself stays "low" in this fixture — the test fixture
    // supplies no `resolved_version` for any dep, so `no_lock_file` is
    // unconditionally set on the CLI path (ADR 0007 §3), and
    // `downstream_dependents_unavailable` is also set (CLI has no
    // libraries.io key by design) — two independent flags. The assertion
    // above is what actually proves ADR 0029 worked: the specific note
    // it targets is gone from the set, a real change from the always-
    // present state that existed before it.
  });
});
