/**
 * runFetchParallelStep unit tests
 *
 * Tests the parallel OSV + registry fetch step in isolation.
 * Mocks fetch to simulate various API responses for all three ecosystems.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runFetchParallelStep } from "./fetch-parallel-step.js";
import type { IngestorResult } from "@deptend/core/pipeline/ecosystem-detection.js";
import {
  createFetchRouter,
  createNpmFetchRouter,
  createPyPIFetchRouter,
  createGoFetchRouter,
} from "../test/mocks/fetch-router.js";

describe("runFetchParallelStep", () => {
  const baseIngestorResult: IngestorResult = {
    ecosystem: "npm",
    dependencies: [
      { package_name: "vulnerable-pkg", version_spec: "^1.0.0", dep_type: "production" },
    ],
    lock_file_present: false,
    manifest_resolved: true,
    warnings: [],
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("npm ecosystem", () => {
    it("fetches OSV advisories and npm registry metadata in parallel", async () => {
      vi.stubGlobal("fetch", await createNpmFetchRouter());

      const result = await runFetchParallelStep(baseIngestorResult);

      expect(result.ecosystem).toBe("npm");
      expect(result.osvResult.advisories.size).toBe(1);
      expect(result.osvResult.advisories.has("GHSA-test-1234")).toBe(true);
      expect(result.osvResult.packageAdvisoryMap.get("vulnerable-pkg")).toEqual(["GHSA-test-1234"]);
      expect(result.registryResult.metadata.has("vulnerable-pkg")).toBe(true);
      expect(result.registryResult.metadata.get("vulnerable-pkg")?.latestVersion).toBe("1.0.1");
      // sourceRepoByPackage extracts only owner/name from registry metadata
      expect(result.sourceRepoByPackage.get("vulnerable-pkg")).toEqual({
        owner: "vulnerable-org",
        name: "vulnerable-pkg",
      });
    });

    it("includes OSV warnings in result when no advisories found", async () => {
      vi.stubGlobal(
        "fetch",
        await createFetchRouter({
          osvBatch: { results: [{ vulns: [] }] },
          osvDetails: {},
          npmRegistry: { version: "1.0.0" },
        }),
      );

      const result = await runFetchParallelStep({
        ...baseIngestorResult,
        dependencies: [
          { package_name: "clean-pkg", version_spec: "^1.0.0", dep_type: "production" },
        ],
      });

      expect(result.osvResult.advisories.size).toBe(0);
      expect(result.osvResult.packageAdvisoryMap.size).toBe(0);
      expect(result.registryResult.metadata.has("clean-pkg")).toBe(true);
    });

    it("handles npm registry API failure gracefully", async () => {
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.osv.dev/v1/querybatch")) {
          return new Response(
            JSON.stringify({
              results: [{ vulns: [{ id: "GHSA-test-1234", modified: "2026-01-01T00:00:00Z" }] }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("api.osv.dev/v1/vulns/")) {
          return new Response(
            JSON.stringify({
              id: "GHSA-test-1234",
              modified: "2026-01-01T00:00:00Z",
              published: "2025-12-01T00:00:00Z",
              summary: "Test",
              severity: [{ type: "CVSS_V3", score: "9.8" }],
              affected: [
                {
                  package: { name: "vulnerable-pkg", ecosystem: "npm" },
                  ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("registry.npmjs.org/")) {
          return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runFetchParallelStep(baseIngestorResult);

      expect(
        result.registryResult.warnings.some((w) => w.includes("npm registry") || w.includes("404")),
      ).toBe(true);
      expect(result.registryResult.metadata.get("vulnerable-pkg")?.latestVersion).toBeNull();
      expect(result.osvResult.advisories.size).toBe(1);
    });
  });

  describe("PyPI ecosystem", () => {
    const pypiIngestorResult: IngestorResult = {
      ...baseIngestorResult,
      ecosystem: "pypi",
      dependencies: [
        { package_name: "vulnerable-pkg", version_spec: ">=1.0.0", dep_type: "production" },
      ],
    };

    it("fetches OSV advisories and PyPI registry metadata in parallel", async () => {
      vi.stubGlobal("fetch", await createPyPIFetchRouter());

      const result = await runFetchParallelStep(pypiIngestorResult);

      expect(result.ecosystem).toBe("pypi");
      expect(result.osvResult.advisories.size).toBe(1);
      expect(result.osvResult.advisories.has("GHSA-test-pypi-1234")).toBe(true);
      expect(result.osvResult.packageAdvisoryMap.get("vulnerable-pkg")).toEqual([
        "GHSA-test-pypi-1234",
      ]);
      expect(result.registryResult.metadata.has("vulnerable-pkg")).toBe(true);
    });

    it("stores internal ecosystem value ('pypi') on advisory row", async () => {
      vi.stubGlobal("fetch", await createPyPIFetchRouter());

      const result = await runFetchParallelStep(pypiIngestorResult);

      const advisory = result.osvResult.advisories.get("GHSA-test-pypi-1234");
      // Advisory ecosystem is internal enum value, not OSV's "PyPI"
      expect(advisory?.ecosystem).toBe("pypi");
    });
  });

  describe("Go ecosystem", () => {
    const goIngestorResult: IngestorResult = {
      ...baseIngestorResult,
      ecosystem: "go",
      dependencies: [
        {
          package_name: "github.com/vulnerable/pkg",
          version_spec: "v1.0.0",
          dep_type: "production",
        },
      ],
    };

    it("fetches OSV advisories and Go module proxy metadata in parallel", async () => {
      vi.stubGlobal("fetch", await createGoFetchRouter());

      const result = await runFetchParallelStep(goIngestorResult);

      expect(result.ecosystem).toBe("go");
      expect(result.osvResult.advisories.size).toBe(1);
      expect(result.osvResult.advisories.has("GHSA-test-go-1234")).toBe(true);
      expect(result.osvResult.packageAdvisoryMap.get("github.com/vulnerable/pkg")).toEqual([
        "GHSA-test-go-1234",
      ]);
      expect(result.registryResult.metadata.has("github.com/vulnerable/pkg")).toBe(true);
      expect(result.registryResult.metadata.get("github.com/vulnerable/pkg")?.latestVersion).toBe(
        "v1.0.1",
      );
    });

    it("stores internal ecosystem value ('go') on advisory row", async () => {
      vi.stubGlobal("fetch", await createGoFetchRouter());

      const result = await runFetchParallelStep(goIngestorResult);

      const advisory = result.osvResult.advisories.get("GHSA-test-go-1234");
      // Advisory ecosystem is internal enum value, not OSV's "Go"
      expect(advisory?.ecosystem).toBe("go");
    });
  });

  describe("multiple dependencies", () => {
    it("deduplicates packages before OSV batch query", async () => {
      const multiDepResult: IngestorResult = {
        ...baseIngestorResult,
        dependencies: [
          { package_name: "lodash", version_spec: "^4.0.0", dep_type: "production" },
          { package_name: "lodash", version_spec: "^4.0.0", dep_type: "development" },
        ],
      };

      let batchCallCount = 0;
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.osv.dev/v1/querybatch")) {
          batchCallCount++;
          return new Response(
            JSON.stringify({
              results: [{ vulns: [{ id: "GHSA-test-1234", modified: "2026-01-01T00:00:00Z" }] }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("api.osv.dev/v1/vulns/")) {
          return new Response(
            JSON.stringify({
              id: "GHSA-test-1234",
              modified: "2026-01-01T00:00:00Z",
              published: "2025-12-01T00:00:00Z",
              summary: "Test",
              severity: [{ type: "CVSS_V3", score: "9.8" }],
              affected: [
                {
                  package: { name: "lodash", ecosystem: "npm" },
                  ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("registry.npmjs.org/")) {
          return new Response(JSON.stringify({ version: "4.17.21" }), { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runFetchParallelStep(multiDepResult);

      // Should only make one batch call despite two deps (same package)
      expect(batchCallCount).toBe(1);
      expect(result.osvResult.packageAdvisoryMap.get("lodash")).toEqual(["GHSA-test-1234"]);
    });

    it("handles multiple packages with different advisories", async () => {
      const multiDepResult: IngestorResult = {
        ...baseIngestorResult,
        dependencies: [
          { package_name: "pkg-a", version_spec: "^1.0.0", dep_type: "production" },
          { package_name: "pkg-b", version_spec: "^2.0.0", dep_type: "production" },
        ],
      };

      // OSV batch returns one result per query (in order of queries)
      // Each query is for a unique package name
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.osv.dev/v1/querybatch")) {
          // Return two results - one for each package query
          return new Response(
            JSON.stringify({
              results: [
                { vulns: [{ id: "GHSA-aaa", modified: "2026-01-01T00:00:00Z" }] },
                { vulns: [{ id: "GHSA-bbb", modified: "2026-01-01T00:00:00Z" }] },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("api.osv.dev/v1/vulns/GHSA-aaa")) {
          return new Response(
            JSON.stringify({
              id: "GHSA-aaa",
              modified: "2026-01-01T00:00:00Z",
              published: "2025-12-01T00:00:00Z",
              summary: "A",
              severity: [{ type: "CVSS_V3", score: "7.5" }],
              affected: [
                {
                  package: { name: "pkg-a", ecosystem: "npm" },
                  ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("api.osv.dev/v1/vulns/GHSA-bbb")) {
          return new Response(
            JSON.stringify({
              id: "GHSA-bbb",
              modified: "2026-01-01T00:00:00Z",
              published: "2025-12-01T00:00:00Z",
              summary: "B",
              severity: [{ type: "CVSS_V3", score: "9.8" }],
              affected: [
                {
                  package: { name: "pkg-b", ecosystem: "npm" },
                  ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "2.0.1" }] }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("registry.npmjs.org/")) {
          return new Response(JSON.stringify({ version: "1.0.1" }), { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runFetchParallelStep(multiDepResult);

      expect(result.osvResult.advisories.size).toBe(2);
      expect(result.osvResult.packageAdvisoryMap.get("pkg-a")).toEqual(["GHSA-aaa"]);
      expect(result.osvResult.packageAdvisoryMap.get("pkg-b")).toEqual(["GHSA-bbb"]);
    });
  });

  describe("empty dependencies", () => {
    it("returns empty results without making network calls", async () => {
      let fetchCalled = false;
      vi.stubGlobal("fetch", async () => {
        fetchCalled = true;
        return new Response("", { status: 200 });
      });

      const result = await runFetchParallelStep({
        ...baseIngestorResult,
        dependencies: [],
      });

      expect(fetchCalled).toBe(false);
      expect(result.osvResult.advisories.size).toBe(0);
      expect(result.osvResult.packageAdvisoryMap.size).toBe(0);
      expect(result.registryResult.metadata.size).toBe(0);
    });
  });

  describe("sourceRepoByPackage", () => {
    it("extracts source repo from registry metadata", async () => {
      vi.stubGlobal(
        "fetch",
        await createFetchRouter({
          npmRegistry: { version: "1.0.1", repository: "vulnerable-org/vulnerable-pkg" },
        }),
      );

      const result = await runFetchParallelStep(baseIngestorResult);

      // SourceRepoRef only has owner and name (host is assumed github.com)
      expect(result.sourceRepoByPackage.get("vulnerable-pkg")).toEqual({
        owner: "vulnerable-org",
        name: "vulnerable-pkg",
      });
    });

    it("handles missing repository field", async () => {
      vi.stubGlobal(
        "fetch",
        await createFetchRouter({
          npmRegistry: { version: "1.0.1" },
        }),
      );

      const result = await runFetchParallelStep(baseIngestorResult);

      expect(result.sourceRepoByPackage.get("vulnerable-pkg")).toBeNull();
    });

    it("handles non-github repository URLs", async () => {
      vi.stubGlobal(
        "fetch",
        await createFetchRouter({
          npmRegistry: { version: "1.0.1", repository: "gitlab.com/owner/repo" },
        }),
      );

      const result = await runFetchParallelStep(baseIngestorResult);

      expect(result.sourceRepoByPackage.get("vulnerable-pkg")).toBeNull();
    });
  });
});
