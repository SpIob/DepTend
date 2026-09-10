/**
 * Performance benchmarks for CLI pipeline.
 *
 * Run with: pnpm vitest bench --config vitest.bench.config.ts
 * Compare with baseline: pnpm vitest bench --config vitest.bench.config.ts --compare ./benchmark-baseline.json
 */

import { describe, bench, beforeAll } from "vitest";
import { runFetchParallelStep } from "./pipeline/fetch-parallel-step.js";
import { runScoreRankStep } from "./pipeline/score-rank-step.js";
import type { IngestorResult } from "@deptend/core/pipeline/ecosystem-detection.js";
import type { OsvFetchResult } from "@deptend/core/ingestor/osv.js";
import type { RegistryFetchResult } from "@deptend/core/ingestor/registry-base.js";
import type { Repo } from "@deptend/core/db/schema.js";
import { buildRepo } from "./build-rows.js";
import type { GitHubRepoMeta } from "@deptend/core/ingestor/github-meta.js";

const baseRepo: Repo = buildRepo({
  full_name: "owner/repo",
  name: "repo",
  owner: { login: "owner" },
  default_branch: "main",
  description: "A test repo",
  stargazers_count: 100,
  open_issues_count: 5,
  topics: [],
  homepage: null,
} as GitHubRepoMeta);

// ============================================================
// Test data generators (deterministic for consistent benchmarks)
// ============================================================

function createMockDeps(count: number): IngestorResult["dependencies"] {
  const deps: IngestorResult["dependencies"] = [];
  for (let i = 0; i < count; i++) {
    deps.push({
      package_name: `pkg-${i}`,
      version_spec: "^1.0.0",
      dep_type: i % 3 === 0 ? "production" : i % 3 === 1 ? "development" : "peer",
      resolved_version: `1.0.${i}`,
      is_transitive: false,
    });
  }
  return deps;
}

function createMockIngestorResult(
  depCount: number,
  ecosystem: "npm" | "pypi" | "go" = "npm",
): IngestorResult {
  return {
    ecosystem,
    dependencies: createMockDeps(depCount),
    lock_file_present: true,
    lock_file_parsed: true,
    manifest_resolved: true,
    warnings: [],
  };
}

function createMockOsvResult(depCount: number): OsvFetchResult {
  const advisories = new Map();
  const packageAdvisoryMap = new Map();

  for (let i = 0; i < depCount; i++) {
    const osvId = `GHSA-${String(i).padStart(4, "0")}-test`;
    const pkg = `pkg-${i}`;

    advisories.set(osvId, {
      osvId,
      source: "ghsa",
      ecosystem: "npm",
      packageName: pkg,
      severity: i % 4 === 0 ? "critical" : i % 4 === 1 ? "high" : i % 4 === 2 ? "medium" : "low",
      cvssScore: 5.0 + (i % 5),
      epssScore: 0.1 + (i % 10) * 0.05,
      summary: `Test advisory ${i}`,
      details: null,
      affectedVersions: ["<1.0.0"],
      fixedVersion: "1.0.1",
      publishedAt: new Date("2024-01-01"),
      modifiedAt: new Date("2024-01-01"),
      rawData: {},
    });

    packageAdvisoryMap.set(pkg, [osvId]);
  }

  return {
    advisories,
    packageAdvisoryMap,
    warnings: [],
  };
}

function createMockRegistryResult(depCount: number): RegistryFetchResult {
  const metadata = new Map();

  for (let i = 0; i < depCount; i++) {
    const pkg = `pkg-${i}`;
    metadata.set(pkg, {
      packageName: pkg,
      latestVersion: "2.0.0",
      isDeprecated: false,
      deprecationNote: null,
      sourceRepo: { owner: "test-org", name: pkg },
    });
  }

  return {
    metadata,
    warnings: [],
  };
}

// ============================================================
// Benchmark suites
// ============================================================

describe("CLI Pipeline Performance Benchmarks", () => {
  // ============================================================
  // runDetectStep benchmarks
  // ============================================================

  describe("runDetectStep", () => {
    bench("detect npm with 10 deps", async () => {
      // runDetectStep requires a filesystem, so we can't easily benchmark it in isolation
      // without a temp directory. We'll skip this for now and focus on the other steps.
      // In a real benchmark, we'd create a temp npm project with package.json and lock files.
    });

    bench("detect npm with 100 deps", async () => {
      // Same as above - requires filesystem
    });

    bench("detect PyPI with 50 deps", async () => {
      // Requires filesystem
    });

    bench("detect Go with 50 deps", async () => {
      // Requires filesystem
    });
  });

  // ============================================================
  // runFetchParallelStep benchmarks
  // ============================================================

  describe("runFetchParallelStep", () => {
    let mockFetch: typeof global.fetch;

    beforeAll(() => {
      mockFetch = global.fetch;
    });

    // Helper to create a mock fetch that returns test data
    function createMockFetch(osvResult: OsvFetchResult, registryResult: RegistryFetchResult) {
      return async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        // OSV batch query
        if (url.includes("api.osv.dev/v1/querybatch")) {
          const results = Array.from(osvResult.packageAdvisoryMap.entries()).map(([_pkg, ids]) => ({
            vulns: ids.map((id) => ({ id, modified: new Date().toISOString() })),
          }));
          return new Response(JSON.stringify({ results }), { status: 200 });
        }

        // OSV detail query
        if (url.includes("api.osv.dev/v1/vulns/")) {
          const osvId = url.split("/vulns/")[1]?.split("/")[0]?.split("?")[0] ?? "";
          const advisory = osvResult.advisories.get(osvId);
          if (advisory) {
            return new Response(JSON.stringify(advisory), { status: 200 });
          }
          return new Response(JSON.stringify({}), { status: 404 });
        }

        // Registry queries (npm, PyPI, Go)
        if (
          url.includes("registry.npmjs.org/") ||
          url.includes("pypi.org/pypi/") ||
          url.includes("proxy.golang.org/")
        ) {
          const pkgName = url.split("/").pop()?.split("?")[0] || "";
          const meta = registryResult.metadata.get(pkgName);
          return new Response(JSON.stringify(meta || {}), { status: meta ? 200 : 404 });
        }

        return new Response("", { status: 404 });
      };
    }

    bench("fetch parallel - 10 deps", async () => {
      const ingestorResult = createMockIngestorResult(10);
      const osvResult = createMockOsvResult(10);
      const registryResult = createMockRegistryResult(10);

      global.fetch = createMockFetch(osvResult, registryResult);

      await runFetchParallelStep(ingestorResult);

      global.fetch = mockFetch;
    });

    bench("fetch parallel - 50 deps", async () => {
      const ingestorResult = createMockIngestorResult(50);
      const osvResult = createMockOsvResult(50);
      const registryResult = createMockRegistryResult(50);

      global.fetch = createMockFetch(osvResult, registryResult);

      await runFetchParallelStep(ingestorResult);

      global.fetch = mockFetch;
    });

    bench("fetch parallel - 100 deps", async () => {
      const ingestorResult = createMockIngestorResult(100);
      const osvResult = createMockOsvResult(100);
      const registryResult = createMockRegistryResult(100);

      global.fetch = createMockFetch(osvResult, registryResult);

      await runFetchParallelStep(ingestorResult);

      global.fetch = mockFetch;
    });

    bench("fetch parallel - 200 deps", async () => {
      const ingestorResult = createMockIngestorResult(200);
      const osvResult = createMockOsvResult(200);
      const registryResult = createMockRegistryResult(200);

      global.fetch = createMockFetch(osvResult, registryResult);

      await runFetchParallelStep(ingestorResult);

      global.fetch = mockFetch;
    });
  });

  // ============================================================
  // runScoreRankStep benchmarks
  // ============================================================

  describe("runScoreRankStep", () => {
    let mockFetch: typeof global.fetch;

    beforeAll(() => {
      mockFetch = global.fetch;
    });

    function createMockGitHubReleases(releases: { tag_name: string; body: string }[]) {
      return async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/") && url.includes("/releases")) {
          return new Response(JSON.stringify(releases), { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      };
    }

    bench("score rank - 10 deps, 10 advisories", async () => {
      const deps = createMockDeps(10);
      const osvResult = createMockOsvResult(10);
      const registryResult = createMockRegistryResult(10);

      const packageNames = deps.map((d) => d.package_name);
      const sourceRepoByPackage = new Map(packageNames.map((p) => [p, { owner: "test", name: p }]));

      global.fetch = createMockGitHubReleases([]);

      await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: createMockIngestorResult(10),
        osvResult,
        registryResult,
        sourceRepoByPackage,
        githubToken: null,
      });

      global.fetch = mockFetch;
    });

    bench("score rank - 50 deps, 50 advisories", async () => {
      const deps = createMockDeps(50);
      const osvResult = createMockOsvResult(50);
      const registryResult = createMockRegistryResult(50);

      const packageNames = deps.map((d) => d.package_name);
      const sourceRepoByPackage = new Map(packageNames.map((p) => [p, { owner: "test", name: p }]));

      global.fetch = createMockGitHubReleases([]);

      await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: createMockIngestorResult(50),
        osvResult,
        registryResult,
        sourceRepoByPackage,
        githubToken: null,
      });

      global.fetch = mockFetch;
    });

    bench("score rank - 100 deps, 100 advisories", async () => {
      const deps = createMockDeps(100);
      const osvResult = createMockOsvResult(100);
      const registryResult = createMockRegistryResult(100);

      const packageNames = deps.map((d) => d.package_name);
      const sourceRepoByPackage = new Map(packageNames.map((p) => [p, { owner: "test", name: p }]));

      global.fetch = createMockGitHubReleases([]);

      await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: createMockIngestorResult(100),
        osvResult,
        registryResult,
        sourceRepoByPackage,
        githubToken: null,
      });

      global.fetch = mockFetch;
    });

    bench("score rank - 200 deps, 200 advisories", async () => {
      const deps = createMockDeps(200);
      const osvResult = createMockOsvResult(200);
      const registryResult = createMockRegistryResult(200);

      const packageNames = deps.map((d) => d.package_name);
      const sourceRepoByPackage = new Map(packageNames.map((p) => [p, { owner: "test", name: p }]));

      global.fetch = createMockGitHubReleases([]);

      await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: createMockIngestorResult(200),
        osvResult,
        registryResult,
        sourceRepoByPackage,
        githubToken: null,
      });

      global.fetch = mockFetch;
    });
  });

  // ============================================================
  // End-to-end pipeline benchmarks (with mocked network)
  // ============================================================

  describe("End-to-end pipeline (mocked)", () => {
    let mockFetch: typeof global.fetch;

    beforeAll(() => {
      mockFetch = global.fetch;
    });

    function createMockFetchFull(
      osvResult: OsvFetchResult,
      registryResult: RegistryFetchResult,
      githubReleases: { tag_name: string; body: string }[] = [],
    ) {
      return async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        // OSV batch query
        if (url.includes("api.osv.dev/v1/querybatch")) {
          const results = Array.from(osvResult.packageAdvisoryMap.entries()).map(([_pkg, ids]) => ({
            vulns: ids.map((id) => ({ id, modified: new Date().toISOString() })),
          }));
          return new Response(JSON.stringify({ results }), { status: 200 });
        }

        // OSV detail query
        if (url.includes("api.osv.dev/v1/vulns/")) {
          const osvId = url.split("/vulns/")[1]?.split("/")[0]?.split("?")[0] ?? "";
          const advisory = osvResult.advisories.get(osvId);
          if (advisory) {
            return new Response(JSON.stringify(advisory), { status: 200 });
          }
          return new Response(JSON.stringify({}), { status: 404 });
        }

        // Registry queries
        if (
          url.includes("registry.npmjs.org/") ||
          url.includes("pypi.org/pypi/") ||
          url.includes("proxy.golang.org/")
        ) {
          const pkgName = url.split("/").pop()?.split("?")[0] || "";
          const meta = registryResult.metadata.get(pkgName);
          return new Response(JSON.stringify(meta || {}), { status: meta ? 200 : 404 });
        }

        // GitHub releases
        if (url.includes("api.github.com/repos/") && url.includes("/releases")) {
          return new Response(JSON.stringify(githubReleases), { status: 200 });
        }

        return new Response("", { status: 404 });
      };
    }

    bench("full pipeline - 10 deps", async () => {
      const depCount = 10;
      const ingestorResult = createMockIngestorResult(depCount);
      const osvResult = createMockOsvResult(depCount);
      const registryResult = createMockRegistryResult(depCount);

      const packageNames = ingestorResult.dependencies.map((d) => d.package_name);
      const sourceRepoByPackage = new Map(packageNames.map((p) => [p, { owner: "test", name: p }]));

      global.fetch = createMockFetchFull(osvResult, registryResult);

      await runFetchParallelStep(ingestorResult);
      await runScoreRankStep({
        repo: baseRepo,
        ingestorResult,
        osvResult,
        registryResult,
        sourceRepoByPackage,
        githubToken: null,
      });

      global.fetch = mockFetch;
    });

    bench("full pipeline - 50 deps", async () => {
      const depCount = 50;
      const ingestorResult = createMockIngestorResult(depCount);
      const osvResult = createMockOsvResult(depCount);
      const registryResult = createMockRegistryResult(depCount);

      const packageNames = ingestorResult.dependencies.map((d) => d.package_name);
      const sourceRepoByPackage = new Map(packageNames.map((p) => [p, { owner: "test", name: p }]));

      global.fetch = createMockFetchFull(osvResult, registryResult);

      await runFetchParallelStep(ingestorResult);
      await runScoreRankStep({
        repo: baseRepo,
        ingestorResult,
        osvResult,
        registryResult,
        sourceRepoByPackage,
        githubToken: null,
      });

      global.fetch = mockFetch;
    });

    bench("full pipeline - 100 deps", async () => {
      const depCount = 100;
      const ingestorResult = createMockIngestorResult(depCount);
      const osvResult = createMockOsvResult(depCount);
      const registryResult = createMockRegistryResult(depCount);

      const packageNames = ingestorResult.dependencies.map((d) => d.package_name);
      const sourceRepoByPackage = new Map(packageNames.map((p) => [p, { owner: "test", name: p }]));

      global.fetch = createMockFetchFull(osvResult, registryResult);

      await runFetchParallelStep(ingestorResult);
      await runScoreRankStep({
        repo: baseRepo,
        ingestorResult,
        osvResult,
        registryResult,
        sourceRepoByPackage,
        githubToken: null,
      });

      global.fetch = mockFetch;
    });
  });
});
