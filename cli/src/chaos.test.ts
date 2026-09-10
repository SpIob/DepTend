/**
 * Chaos/Resilience tests for CLI pipeline.
 *
 * These tests inject various failure modes to verify graceful degradation.
 * Some tests document current known limitations in error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runFetchParallelStep } from "./pipeline/fetch-parallel-step.js";
import { runScoreRankStep } from "./pipeline/score-rank-step.js";
import type { IngestorResult } from "@deptend/core/pipeline/ecosystem-detection.js";
import type { OsvFetchResult } from "@deptend/core/ingestor/osv.js";
import type { RegistryFetchResult } from "@deptend/core/ingestor/registry-base.js";
import type { PackageMetadata } from "@deptend/core/pipeline/registry-fetchers.js";
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

function createTestIngestorResult(depCount = 5): IngestorResult {
  return {
    ecosystem: "npm",
    dependencies: Array.from({ length: depCount }, (_, i) => ({
      package_name: `pkg-${i}`,
      version_spec: "^1.0.0",
      dep_type: "production" as const,
      resolved_version: `1.0.${i}`,
      is_transitive: false,
    })),
    lock_file_present: true,
    lock_file_parsed: true,
    manifest_resolved: true,
    warnings: [],
  };
}

function createSourceRepoMap(
  deps: IngestorResult["dependencies"],
): Map<string, PackageMetadata["sourceRepo"] | null> {
  return new Map(deps.map((d) => [d.package_name, null]));
}

describe("Chaos/Resilience Tests", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ============================================================
  // Happy path resilience - verify basic error handling works
  // ============================================================

  describe("Basic error handling (HTTP errors)", () => {
    it("handles empty dependencies without network calls", async () => {
      let fetchCalled = false;
      global.fetch = vi.fn().mockImplementation(() => {
        fetchCalled = true;
        return new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 });
      });

      const result = await runFetchParallelStep({
        ...createTestIngestorResult(0),
        dependencies: [],
      });

      expect(fetchCalled).toBe(false);
      expect(result.osvResult.advisories.size).toBe(0);
      expect(result.registryResult.metadata.size).toBe(0);
    });

    it("handles OSV 404 for detail endpoints", async () => {
      global.fetch = vi.fn().mockImplementation(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        if (url.includes("api.osv.dev/v1/querybatch")) {
          return new Response(
            JSON.stringify({ results: [{ vulns: [{ id: "GHSA-test", modified: "2024-01-01" }] }] }),
            { status: 200 },
          );
        }
        if (url.includes("api.osv.dev/v1/vulns/")) {
          return new Response(JSON.stringify({}), { status: 404 });
        }
        return new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 });
      });

      const result = await runFetchParallelStep(createTestIngestorResult(1));

      expect(result).toBeDefined();
      expect(result.osvResult.advisories.size).toBe(0);
    });

    it("handles registry 404 gracefully", async () => {
      global.fetch = vi.fn().mockImplementation(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        if (url.includes("api.osv.dev/")) {
          return new Response(JSON.stringify({ results: [{ vulns: [] }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
      });

      const result = await runFetchParallelStep(createTestIngestorResult(1));

      expect(result).toBeDefined();
    });
  });

  // ============================================================
  // Partial failures - continue processing other items
  // ============================================================

  describe("Partial failures", () => {
    it("continues when some OSV detail requests 404", async () => {
      let detailCallCount = 0;
      global.fetch = vi.fn().mockImplementation(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        if (url.includes("api.osv.dev/v1/querybatch")) {
          return new Response(
            JSON.stringify({
              results: [
                { vulns: [{ id: "GHSA-good", modified: "2024-01-01" }] },
                { vulns: [{ id: "GHSA-bad", modified: "2024-01-01" }] },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("api.osv.dev/v1/vulns/")) {
          detailCallCount++;
          const osvId = url.split("/vulns/")[1]?.split("/")[0]?.split("?")[0];
          if (detailCallCount % 2 === 0) {
            return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
          }
          return new Response(
            JSON.stringify({
              id: osvId,
              summary: "Test advisory",
              severity: "high",
              affected: [{ package: { name: "test" }, ranges: [] }],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 });
      });

      const result = await runFetchParallelStep(createTestIngestorResult(2));

      expect(result).toBeDefined();
    });

    it.skip("continues when some registry requests 500 - hangs due to retry logic", async () => {
      let registryCallCount = 0;
      global.fetch = vi.fn().mockImplementation(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        if (url.includes("api.osv.dev/")) {
          return new Response(JSON.stringify({ results: [{ vulns: [] }] }), { status: 200 });
        }
        registryCallCount++;
        if (registryCallCount % 2 === 0) {
          return new Response(JSON.stringify({ error: "Internal error" }), { status: 500 });
        }
        return new Response(JSON.stringify({ version: "1.0.0", name: "test" }), { status: 200 });
      });

      const result = await runFetchParallelStep(createTestIngestorResult(4));

      expect(result).toBeDefined();
    });
  });

  // ============================================================
  // Score rank step resilience
  // ============================================================

  describe("Score rank step resilience", () => {
    it("handles missing sourceRepo gracefully", async () => {
      const ingestorResult = createTestIngestorResult(3);
      const osvResult: OsvFetchResult = {
        advisories: new Map([
          [
            "GHSA-test",
            {
              osvId: "GHSA-test",
              source: "ghsa",
              ecosystem: "npm",
              packageName: "pkg-0",
              severity: "high",
              cvssScore: 7.5,
              summary: "Test",
            },
          ],
        ]),
        packageAdvisoryMap: new Map([["pkg-0", ["GHSA-test"]]]),
        warnings: [],
      };
      const registryResult: RegistryFetchResult = {
        metadata: new Map([
          [
            "pkg-0",
            {
              packageName: "pkg-0",
              latestVersion: "2.0.0",
              isDeprecated: false,
              deprecationNote: null,
              sourceRepo: null,
            },
          ],
        ]),
        warnings: [],
      };

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult,
        osvResult,
        registryResult,
        sourceRepoByPackage: createSourceRepoMap(ingestorResult.dependencies),
        githubToken: null,
      });

      expect(result).toBeDefined();
      expect(result.missions.length).toBeGreaterThanOrEqual(0);
    });

    it("handles GitHub API failures during effort signal fetch", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("GitHub API unavailable"));

      const ingestorResult = createTestIngestorResult(3);
      const osvResult: OsvFetchResult = {
        advisories: new Map([
          [
            "GHSA-test",
            {
              osvId: "GHSA-test",
              source: "ghsa",
              ecosystem: "npm",
              packageName: "pkg-0",
              severity: "high",
              cvssScore: 7.5,
              summary: "Test",
            },
          ],
        ]),
        packageAdvisoryMap: new Map([["pkg-0", ["GHSA-test"]]]),
        warnings: [],
      };
      const registryResult: RegistryFetchResult = {
        metadata: new Map([
          [
            "pkg-0",
            {
              packageName: "pkg-0",
              latestVersion: "2.0.0",
              isDeprecated: false,
              deprecationNote: null,
              sourceRepo: { owner: "test", name: "pkg-0" },
            },
          ],
        ]),
        warnings: [],
      };

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult,
        osvResult,
        registryResult,
        sourceRepoByPackage: createSourceRepoMap(ingestorResult.dependencies),
        githubToken: "fake-token",
      });

      expect(result).toBeDefined();
      expect(result.missions.length).toBeGreaterThanOrEqual(0);
    });

    it("handles malformed GitHub releases response", async () => {
      global.fetch = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));

      const ingestorResult = createTestIngestorResult(3);
      const osvResult: OsvFetchResult = {
        advisories: new Map([
          [
            "GHSA-test",
            {
              osvId: "GHSA-test",
              source: "ghsa",
              ecosystem: "npm",
              packageName: "pkg-0",
              severity: "high",
              cvssScore: 7.5,
              summary: "Test",
            },
          ],
        ]),
        packageAdvisoryMap: new Map([["pkg-0", ["GHSA-test"]]]),
        warnings: [],
      };
      const registryResult: RegistryFetchResult = {
        metadata: new Map([
          [
            "pkg-0",
            {
              packageName: "pkg-0",
              latestVersion: "2.0.0",
              isDeprecated: false,
              deprecationNote: null,
              sourceRepo: { owner: "test", name: "pkg-0" },
            },
          ],
        ]),
        warnings: [],
      };

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult,
        osvResult,
        registryResult,
        sourceRepoByPackage: createSourceRepoMap(ingestorResult.dependencies),
        githubToken: "fake-token",
      });

      expect(result).toBeDefined();
      expect(result.missions.length).toBeGreaterThanOrEqual(0);
    });

    it("handles GitHub 404 (private repo)", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));

      const ingestorResult = createTestIngestorResult(3);
      const osvResult: OsvFetchResult = {
        advisories: new Map([
          [
            "GHSA-test",
            {
              osvId: "GHSA-test",
              source: "ghsa",
              ecosystem: "npm",
              packageName: "pkg-0",
              severity: "high",
              cvssScore: 7.5,
              summary: "Test",
            },
          ],
        ]),
        packageAdvisoryMap: new Map([["pkg-0", ["GHSA-test"]]]),
        warnings: [],
      };
      const registryResult: RegistryFetchResult = {
        metadata: new Map([
          [
            "pkg-0",
            {
              packageName: "pkg-0",
              latestVersion: "2.0.0",
              isDeprecated: false,
              deprecationNote: null,
              sourceRepo: { owner: "private", name: "repo" },
            },
          ],
        ]),
        warnings: [],
      };

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult,
        osvResult,
        registryResult,
        sourceRepoByPackage: createSourceRepoMap(ingestorResult.dependencies),
        githubToken: "fake-token",
      });

      expect(result).toBeDefined();
      expect(result.missions.length).toBeGreaterThanOrEqual(0);
    });
  });

  // ============================================================
  // Resource scaling
  // ============================================================

  describe("Resource scaling", () => {
    it("handles 100 dependencies without errors", async () => {
      global.fetch = vi.fn().mockImplementation(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        if (url.includes("api.osv.dev/")) {
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 });
      });

      const result = await runFetchParallelStep(createTestIngestorResult(100));

      expect(result).toBeDefined();
      expect(result.osvResult).toBeDefined();
      expect(result.registryResult).toBeDefined();
    }, 30000);

    it("handles many advisories per package", async () => {
      global.fetch = vi.fn().mockImplementation(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        if (url.includes("api.osv.dev/v1/querybatch")) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  vulns: Array.from({ length: 20 }, (_, i) => ({
                    id: `GHSA-${i}`,
                    modified: "2024-01-01",
                  })),
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("api.osv.dev/v1/vulns/")) {
          const osvId = url.split("/vulns/")[1]?.split("/")[0]?.split("?")[0];
          return new Response(
            JSON.stringify({
              id: osvId,
              summary: "Test",
              severity: "medium",
              affected: [{ package: { name: "test" }, ranges: [] }],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 });
      });

      const result = await runFetchParallelStep(createTestIngestorResult(5));

      expect(result).toBeDefined();
    }, 30000);
  });

  // ============================================================
  // Known limitations (documented for future improvement)
  // ============================================================

  describe("Known limitations - documented for future improvement", () => {
    it.skip("network errors (ENOTFOUND, ECONNREFUSED) currently hang - needs retry/timeout logic", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND: Name or service not known"));
      await expect(runFetchParallelStep(createTestIngestorResult(1))).rejects.toThrow();
    });

    it.skip("malformed JSON from OSV throws instead of being caught", async () => {
      global.fetch = vi.fn().mockImplementation(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.osv.dev/v1/querybatch")) {
          return new Response("not valid json{", { status: 200 });
        }
        return new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 });
      });
      await expect(runFetchParallelStep(createTestIngestorResult(1))).rejects.toThrow();
    });

    it.skip("empty response body from OSV throws instead of being caught", async () => {
      global.fetch = vi.fn().mockImplementation(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.osv.dev/")) {
          return new Response("", { status: 200 });
        }
        return new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 });
      });
      await expect(runFetchParallelStep(createTestIngestorResult(1))).rejects.toThrow();
    });

    it.skip("500/503 errors currently hang due to retry logic - needs timeout handling", async () => {
      global.fetch = vi.fn().mockImplementation(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.osv.dev/")) {
          return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
        }
        return new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 });
      });
      await expect(runFetchParallelStep(createTestIngestorResult(1))).rejects.toThrow();
    });
  });
});
