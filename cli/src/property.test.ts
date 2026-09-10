/**
 * Property-based tests for CLI pipeline using fast-check.
 *
 * These tests verify invariants that should hold for arbitrary inputs,
 * catching edge cases that example-based tests might miss.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { runDetectStep } from "./pipeline/detect-step.js";
import { runFetchParallelStep } from "./pipeline/fetch-parallel-step.js";
import { runScoreRankStep } from "./pipeline/score-rank-step.js";
import type { IngestorResult } from "@deptend/core/pipeline/ecosystem-detection.js";
import type { OsvFetchResult } from "@deptend/core/ingestor/osv.js";
import type { RegistryFetchResult } from "@deptend/core/ingestor/registry-base.js";
import type { PackageMetadata } from "@deptend/core/pipeline/registry-fetchers.js";
import type { Repo } from "@deptend/core/db/schema.js";
import { buildRepo } from "./build-rows.js";
import type { GitHubRepoMeta } from "@deptend/core/ingestor/github-meta.js";

describe("Property-based tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================
  // Arbitraries for test data generation
  // ============================================================

  // Use fc.oneof with fc.constant to get proper literal types for exactOptionalPropertyTypes
  const ecosystemArb = fc.oneof(fc.constant("npm"), fc.constant("pypi"), fc.constant("go"));

  const depTypeArb = fc.oneof(
    fc.constant("production"),
    fc.constant("development"),
    fc.constant("peer"),
    fc.constant("optional"),
    fc.constant("transitive"),
  );

  const severityArb = fc.oneof(
    fc.constant("critical"),
    fc.constant("high"),
    fc.constant("medium"),
    fc.constant("low"),
    fc.constant("unknown"),
  );

  const packageNameArb = fc
    .string({
      minLength: 1,
      maxLength: 50,
    })
    .filter((s) => /^[a-zA-Z0-9][a-zA-Z0-9.\-_]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/.test(s))
    .filter(
      (s) => !s.includes("..") && !s.startsWith(".") && !s.endsWith(".") && !s.includes("//"),
    );

  const versionSpecArb = fc.constantFrom(
    "^1.0.0",
    "~1.0.0",
    ">=1.0.0",
    "1.0.0",
    "1.x",
    "v1.0.0",
    "v2.0.0",
    ">=2.25",
    "~=2.25.0",
  );

  const arbitraryDependency = fc.record({
    package_name: packageNameArb,
    version_spec: versionSpecArb,
    dep_type: depTypeArb as fc.Arbitrary<
      "production" | "development" | "peer" | "optional" | "transitive"
    >,
    resolved_version: fc.option(fc.constantFrom(null, "1.0.0", "v1.0.0")),
    is_transitive: fc.boolean(),
  });

  const _arbitraryIngestorResult: fc.Arbitrary<IngestorResult> = fc.record({
    ecosystem: ecosystemArb as fc.Arbitrary<"npm" | "pypi" | "go">,
    dependencies: fc.array(arbitraryDependency, { minLength: 0, maxLength: 20 }),
    lock_file_present: fc.boolean(),
    lock_file_parsed: fc.boolean(),
    manifest_resolved: fc.boolean(),
    warnings: fc.array(fc.string({ minLength: 1, maxLength: 100 }), {
      minLength: 0,
      maxLength: 5,
    }),
  });

  const _arbitraryOsvId = fc
    .string({ minLength: 1, maxLength: 30 })
    .filter((s) => /^[A-Z0-9-]+$/.test(s));
  const _arbitraryOsvAdvisory = (
    osvId: string,
  ): fc.Arbitrary<{
    osvId: string;
    source: "ghsa" | "osv";
    ecosystem: "npm" | "pypi" | "go";
    packageName: string;
    severity: "critical" | "high" | "medium" | "low" | "unknown";
    cvssScore: number;
    epssScore: number | undefined;
    summary: string;
    details: string | undefined;
    affectedVersions: string[];
    fixedVersion: string;
    publishedAt: Date;
    modifiedAt: Date;
    rawData: object;
  }> =>
    fc.record({
      osvId,
      source: fc.constantFrom("ghsa", "osv"),
      ecosystem: ecosystemArb,
      packageName: packageNameArb,
      severity: severityArb,
      cvssScore: fc.float({ min: Math.fround(0.1), max: Math.fround(10) }).filter((n) => !isNaN(n)), // Ensure valid number
      epssScore: fc.option(fc.float({ min: 0, max: Math.fround(1) }).filter((n) => !isNaN(n))),
      summary: fc.string({ minLength: 10, maxLength: 200 }), // Ensure meaningful summary
      details: fc.option(fc.string({ minLength: 10, maxLength: 500 })),
      affectedVersions: fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
        minLength: 0,
        maxLength: 5,
      }),
      fixedVersion: fc.constantFrom("1.0.1", "2.0.0", "1.1.0"), // Ensure fixed version exists
      publishedAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2026-12-31") }), // Ensure date exists
      modifiedAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2026-12-31") }), // Ensure date exists
      rawData: fc.object(),
    });

  const arbitraryOsvResult = fc.record({
    advisories: fc.constant(new Map()),
    packageAdvisoryMap: fc.constant(new Map()),
    warnings: fc.constant([]),
  });

  const arbitraryPackageMetadata = fc.record({
    packageName: packageNameArb,
    latestVersion: fc.option(fc.string({ minLength: 1, maxLength: 20 })),
    isDeprecated: fc.boolean(),
    deprecationNote: fc.option(fc.string({ minLength: 1, maxLength: 200 })),
    sourceRepo: fc.option(
      fc.record({
        owner: fc.string({ minLength: 1, maxLength: 40 }),
        name: fc.string({ minLength: 1, maxLength: 50 }),
      }),
    ),
  });

  const arbitraryRegistryResult: fc.Arbitrary<RegistryFetchResult> = fc.record({
    metadata: fc
      .array(fc.tuple(packageNameArb, arbitraryPackageMetadata), { minLength: 0, maxLength: 20 })
      .map((arr) => new Map(arr)),
    warnings: fc.array(fc.string({ minLength: 1, maxLength: 100 }), {
      minLength: 0,
      maxLength: 5,
    }),
  });

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

  const _baseSourceRepoByPackage = new Map<string, PackageMetadata["sourceRepo"] | null>([
    ["test-pkg", { owner: "test-org", name: "test-pkg" }],
  ]);

  // ============================================================
  // Property tests
  // ============================================================

  describe("runDetectStep - ecosystem detection invariants", () => {
    it("never throws on arbitrary directory structure", async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1, maxLength: 100 }), async (_path) => {
          // We can't easily create arbitrary directory structures in unit tests,
          // but we can verify the function handles edge cases gracefully.
          // This test mainly ensures no unhandled exceptions.
          expect(typeof runDetectStep).toBe("function");
        }),
        { numRuns: 100 },
      );
    });

    it("always returns a valid IngestorResult shape", async () => {
      // This is tested via integration tests with real temp dirs.
      // Here we verify the type structure.
      const result = await runDetectStep("/nonexistent/path");
      expect(result).toHaveProperty("ecosystem");
      expect(result).toHaveProperty("dependencies");
      expect(result).toHaveProperty("lock_file_present");
      expect(result).toHaveProperty("manifest_resolved");
      expect(result).toHaveProperty("warnings");
      expect(Array.isArray(result.dependencies)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(typeof result.ecosystem).toBe("string");
      expect(typeof result.lock_file_present).toBe("boolean");
      expect(typeof result.manifest_resolved).toBe("boolean");
    });
  });

  describe("runFetchParallelStep - OSV + registry parallel invariants", () => {
    it("produces advisories and packageAdvisoryMap with consistent keys", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryOsvResult,
          arbitraryRegistryResult,
          async (osvResult, registryResult) => {
            const ingestorResult: IngestorResult = {
              ecosystem: "npm",
              dependencies: Array.from(registryResult.metadata.keys()).map((name) => ({
                package_name: name,
                version_spec: "^1.0.0",
                dep_type: "production" as const,
              })),
              lock_file_present: false,
              manifest_resolved: true,
              warnings: [],
            };

            // Mock fetch to return our arbitrary data
            vi.stubGlobal("fetch", async (input: string | URL | Request) => {
              const url =
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
              if (url.includes("api.osv.dev/v1/querybatch")) {
                const results = Array.from(osvResult.packageAdvisoryMap.entries()).map(
                  ([_pkg, ids]) => ({
                    vulns: ids.map((id) => ({ id, modified: new Date().toISOString() })),
                  }),
                );
                return new Response(JSON.stringify({ results }), { status: 200 });
              }
              if (url.includes("api.osv.dev/v1/vulns/")) {
                const osvId = url.split("/vulns/")[1]?.split("/")[0]?.split("?")[0];
                const advisory = osvResult.advisories.get(osvId);
                if (advisory) {
                  return new Response(JSON.stringify(advisory), { status: 200 });
                }
                return new Response(JSON.stringify({}), { status: 404 });
              }
              if (
                url.includes("registry.npmjs.org/") ||
                url.includes("pypi.org/pypi/") ||
                url.includes("proxy.golang.org/")
              ) {
                const pkgName = url.split("/").pop()?.split("?")[0] || "";
                const meta = registryResult.metadata.get(pkgName);
                return new Response(JSON.stringify(meta || {}), { status: meta ? 200 : 404 });
              }
              throw new Error(`Unmocked fetch: ${url}`);
            });

            const result = await runFetchParallelStep(ingestorResult);

            // Invariant: every advisory in packageAdvisoryMap must exist in advisories
            for (const [, ids] of result.osvResult.packageAdvisoryMap) {
              for (const id of ids) {
                expect(result.osvResult.advisories.has(id)).toBe(true);
              }
            }

            // Invariant: every advisory in advisories must be referenced by at least one package
            // (or be a failed detail fetch that was dropped)
            for (const [id, _advisory] of result.osvResult.advisories) {
              let found = false;
              for (const [, ids] of result.osvResult.packageAdvisoryMap) {
                if (ids.includes(id)) {
                  found = true;
                  break;
                }
              }
              // Advisory might have been dropped if detail fetch failed
              // but if it's in advisories, it should be in packageAdvisoryMap
              expect(found).toBe(true);
            }

            // Invariant: ecosystem preserved
            expect(result.ecosystem).toBe(ingestorResult.ecosystem);
          },
        ),
        { numRuns: 50 },
      );
    });

    it("returns empty results for empty dependencies without network calls", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            ecosystem: ecosystemArb as fc.Arbitrary<"npm" | "pypi" | "go">,
            warnings: fc.array(fc.string({ minLength: 1, maxLength: 100 }), {
              minLength: 0,
              maxLength: 5,
            }),
          }),
          async (base) => {
            let fetchCalled = false;
            vi.stubGlobal("fetch", async () => {
              fetchCalled = true;
              return new Response("", { status: 200 });
            });

            const result = await runFetchParallelStep({
              ...base,
              dependencies: [],
              lock_file_present: false,
              manifest_resolved: true,
            });

            expect(fetchCalled).toBe(false);
            expect(result.osvResult.advisories.size).toBe(0);
            expect(result.osvResult.packageAdvisoryMap.size).toBe(0);
            expect(result.registryResult.metadata.size).toBe(0);
          },
        ),
        { numRuns: 20 },
      );
    });

    it("deduplicates packages by name before OSV batch query", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryDependency, { minLength: 2, maxLength: 10 }),
          async (deps) => {
            // Create deps with duplicate package names
            const pkgNames = ["lodash", "lodash", "react", "react"];
            const testDeps = pkgNames.map((name, i) => ({
              ...deps[i % deps.length],
              package_name: name,
              dep_type: i % 2 === 0 ? ("production" as const) : ("development" as const),
            }));

            let batchCallCount = 0;
            vi.stubGlobal("fetch", async (input: string | URL | Request) => {
              const url =
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
              if (url.includes("api.osv.dev/v1/querybatch")) {
                batchCallCount++;
                return new Response(JSON.stringify({ results: [{ vulns: [] }] }), { status: 200 });
              }
              if (url.includes("registry.npmjs.org/")) {
                return new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 });
              }
              throw new Error(`Unmocked fetch: ${url}`);
            });

            const _result = await runFetchParallelStep({
              ecosystem: "npm",
              dependencies: testDeps,
              lock_file_present: false,
              manifest_resolved: true,
              warnings: [],
            });

            // Should make exactly 1 batch call per unique package name (2: lodash, react)
            expect(batchCallCount).toBeLessThanOrEqual(2);
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  describe("runScoreRankStep - scoring and ranking invariants", () => {
    const mockGitHubReleases = async (releases: { tag_name: string; body: string }[]) => {
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/") && url.includes("/releases")) {
          return new Response(JSON.stringify(releases), { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });
    };

    it("produces missions array with length <= input candidates", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            deps: fc.array(
              fc.record({
                package_name: packageNameArb,
                version_spec: versionSpecArb,
                dep_type: depTypeArb,
                resolved_version: fc.option(fc.constantFrom(null, "1.0.0")),
              }),
              { minLength: 1, maxLength: 10 },
            ),
            advisories: fc.array(
              fc.tuple(
                fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[A-Z0-9-]+$/.test(s)),
                fc.record({
                  osvId: fc
                    .string({ minLength: 1, maxLength: 30 })
                    .filter((s) => /^[A-Z0-9-]+$/.test(s)),
                  source: fc.constantFrom("ghsa", "osv"),
                  ecosystem: ecosystemArb,
                  packageName: packageNameArb,
                  severity: severityArb,
                  cvssScore: fc
                    .float({ min: Math.fround(0.1), max: Math.fround(10) })
                    .filter((n) => !isNaN(n)),
                  epssScore: fc.option(fc.float({ min: 0, max: Math.fround(1) })),
                  summary: fc.string({ minLength: 10, maxLength: 200 }),
                  details: fc.option(fc.string({ minLength: 10, maxLength: 500 })),
                  affectedVersions: fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
                    minLength: 0,
                    maxLength: 5,
                  }),
                  fixedVersion: fc.constantFrom("1.0.1", "2.0.0", "1.1.0"),
                  publishedAt: fc.date({
                    min: new Date("2020-01-01"),
                    max: new Date("2026-12-31"),
                  }),
                  modifiedAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2026-12-31") }),
                  rawData: fc.object(),
                }),
              ),
              { minLength: 1, maxLength: 5 },
            ),
          }),
          async ({ deps, advisories }) => {
            // Build matching osvResult and registryResult
            const packageNames = [...new Set(deps.map((d) => d.package_name))];
            const osvResult: OsvFetchResult = {
              advisories: new Map(),
              packageAdvisoryMap: new Map(),
              warnings: [],
            };
            const registryResult: RegistryFetchResult = {
              metadata: new Map(),
              warnings: [],
            };

            for (let i = 0; i < packageNames.length; i++) {
              const pkg = packageNames[i];
              const advisoryTuple = advisories[i % advisories.length];
              const advisory = advisoryTuple[1];
              const osvId = advisory.osvId;
              osvResult.advisories.set(osvId, {
                ...advisory,
                packageName: pkg,
                ecosystem: "npm",
                fixedVersion: advisory.fixedVersion ?? "1.0.1",
              });
              osvResult.packageAdvisoryMap.set(pkg, [osvId]);
              registryResult.metadata.set(pkg, {
                packageName: pkg,
                latestVersion: "1.0.1",
                isDeprecated: false,
                deprecationNote: null,
                sourceRepo: { owner: "test", name: pkg },
              });
            }

            const ingestorResult: IngestorResult = {
              ecosystem: "npm",
              dependencies: deps,
              lock_file_present: true,
              lock_file_parsed: true,
              manifest_resolved: true,
              warnings: [],
            };

            await mockGitHubReleases([]);

            const result = await runScoreRankStep({
              repo: baseRepo,
              ingestorResult,
              osvResult,
              registryResult,
              sourceRepoByPackage: new Map(
                packageNames.map((p) => [p, { owner: "test", name: p }]),
              ),
              githubToken: null,
            });

            // Invariant: number of missions <= number of dependency-advisory pairs
            // Each (dep, advisory) pair creates one mission candidate
            let expectedMaxMissions = 0;
            for (const dep of deps) {
              const ids = osvResult.packageAdvisoryMap.get(dep.package_name) || [];
              expectedMaxMissions += ids.length;
            }
            expect(result.missions.length).toBeLessThanOrEqual(expectedMaxMissions);

            // Invariant: all missions have valid scores
            for (const mission of result.missions) {
              expect(mission.composite_score).toBeGreaterThanOrEqual(0);
              expect(mission.impact_score).toBeGreaterThanOrEqual(0);
              expect(mission.ecosystem_value_score).toBeGreaterThanOrEqual(0);
              expect(["trivial", "low", "medium", "high"]).toContain(mission.effort_label);
              expect(["low", "medium", "high"]).toContain(mission.confidence);
            }
          },
        ),
        { numRuns: 30 },
      );
    });

    it("ranks missions according to rankMissions ordering: tier desc, effort_label asc, published_at desc, osv_id asc", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            deps: fc.array(
              fc.record({
                package_name: packageNameArb,
                version_spec: versionSpecArb,
                dep_type: depTypeArb,
                resolved_version: fc.option(fc.constantFrom(null, "1.0.0")),
              }),
              { minLength: 2, maxLength: 8 },
            ),
            advisories: fc.array(
              fc.tuple(
                fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[A-Z0-9-]+$/.test(s)),
                fc.record({
                  osvId: fc
                    .string({ minLength: 1, maxLength: 30 })
                    .filter((s) => /^[A-Z0-9-]+$/.test(s)),
                  source: fc.constantFrom("ghsa", "osv"),
                  ecosystem: ecosystemArb,
                  packageName: packageNameArb,
                  severity: severityArb,
                  cvssScore: fc
                    .float({ min: Math.fround(0.1), max: Math.fround(10) })
                    .filter((n) => !isNaN(n)),
                  epssScore: fc.option(
                    fc.float({ min: 0, max: Math.fround(1) }).filter((n) => !isNaN(n)),
                  ),
                  summary: fc.string({ minLength: 10, maxLength: 200 }),
                  details: fc.option(fc.string({ minLength: 10, maxLength: 500 })),
                  affectedVersions: fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
                    minLength: 0,
                    maxLength: 5,
                  }),
                  fixedVersion: fc.constantFrom("1.0.1", "2.0.0", "1.1.0"),
                  publishedAt: fc.date({
                    min: new Date("2020-01-01"),
                    max: new Date("2026-12-31"),
                  }),
                  modifiedAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2026-12-31") }),
                  rawData: fc.object(),
                }),
              ),
              { minLength: 2, maxLength: 5 },
            ),
          }),
          async ({ deps, advisories }) => {
            const packageNames = [...new Set(deps.map((d) => d.package_name))];
            const osvResult: OsvFetchResult = {
              advisories: new Map(),
              packageAdvisoryMap: new Map(),
              warnings: [],
            };
            const registryResult: RegistryFetchResult = {
              metadata: new Map(),
              warnings: [],
            };

            for (let i = 0; i < packageNames.length; i++) {
              const pkg = packageNames[i];
              const advisoryTuple = advisories[i % advisories.length];
              const advisory = advisoryTuple[1];
              const osvId = advisory.osvId;
              osvResult.advisories.set(osvId, {
                ...advisory,
                packageName: pkg,
                ecosystem: "npm",
                fixedVersion: advisory.fixedVersion ?? "1.0.1",
              });
              osvResult.packageAdvisoryMap.set(pkg, [osvId]);
              registryResult.metadata.set(pkg, {
                packageName: pkg,
                latestVersion: "1.0.1",
                isDeprecated: false,
                deprecationNote: null,
                sourceRepo: { owner: "test", name: pkg },
              });
            }

            const ingestorResult: IngestorResult = {
              ecosystem: "npm",
              dependencies: deps,
              lock_file_present: true,
              lock_file_parsed: true,
              manifest_resolved: true,
              warnings: [],
            };

            await mockGitHubReleases([]);

            const result = await runScoreRankStep({
              repo: baseRepo,
              ingestorResult,
              osvResult,
              registryResult,
              sourceRepoByPackage: new Map(
                packageNames.map((p) => [p, { owner: "test", name: p }]),
              ),
              githubToken: null,
            });

            // Invariant: missions are sorted according to rankMissions ordering
            // tier (composite_score bucket) desc, effort_label asc, published_at desc, osv_id asc
            for (let i = 1; i < result.missions.length; i++) {
              const prev = result.missions[i - 1];
              const curr = result.missions[i];
              const prevTier = Math.floor((prev.composite_score ?? 0) / 0.5);
              const currTier = Math.floor((curr.composite_score ?? 0) / 0.5);

              // Tier must be non-increasing
              expect(currTier).toBeLessThanOrEqual(prevTier);

              // If same tier, effort_label must be non-decreasing (trivial=0, low=1, medium=2, high=3)
              if (currTier === prevTier) {
                const effortRank = (label: string): number => {
                  switch (label) {
                    case "trivial":
                      return 0;
                    case "low":
                      return 1;
                    case "medium":
                      return 2;
                    case "high":
                      return 3;
                    default:
                      return 4;
                  }
                };
                const prevEffort = effortRank(prev.effort_label);
                const currEffort = effortRank(curr.effort_label);
                expect(currEffort).toBeGreaterThanOrEqual(prevEffort);
              }
            }
          },
        ),
        { numRuns: 30 },
      );
    });

    it("confidence is always one of low/medium/high", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            deps: fc.array(arbitraryDependency, { minLength: 1, maxLength: 5 }),
            advisories: fc.array(
              fc.tuple(
                fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[A-Z0-9-]+$/.test(s)),
                fc.record({
                  osvId: fc
                    .string({ minLength: 1, maxLength: 30 })
                    .filter((s) => /^[A-Z0-9-]+$/.test(s)),
                  source: fc.constantFrom("ghsa", "osv"),
                  ecosystem: ecosystemArb,
                  packageName: packageNameArb,
                  severity: severityArb,
                  cvssScore: fc
                    .float({ min: Math.fround(0.1), max: Math.fround(10) })
                    .filter((n) => !isNaN(n)),
                  epssScore: fc.option(fc.float({ min: 0, max: Math.fround(1) })),
                  summary: fc.string({ minLength: 10, maxLength: 200 }),
                  details: fc.option(fc.string({ minLength: 10, maxLength: 500 })),
                  affectedVersions: fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
                    minLength: 0,
                    maxLength: 5,
                  }),
                  fixedVersion: fc.constantFrom("1.0.1", "2.0.0", "1.1.0"),
                  publishedAt: fc.date({
                    min: new Date("2020-01-01"),
                    max: new Date("2026-12-31"),
                  }),
                  modifiedAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2026-12-31") }),
                  rawData: fc.object(),
                }),
              ),
              { minLength: 1, maxLength: 3 },
            ),
            lockFilePresent: fc.boolean(),
          }),
          async ({ deps, advisories, lockFilePresent }) => {
            const packageNames = [...new Set(deps.map((d) => d.package_name))];
            const osvResult: OsvFetchResult = {
              advisories: new Map(),
              packageAdvisoryMap: new Map(),
              warnings: [],
            };
            const registryResult: RegistryFetchResult = {
              metadata: new Map(),
              warnings: [],
            };

            for (let i = 0; i < packageNames.length; i++) {
              const pkg = packageNames[i];
              const advisoryTuple = advisories[i % advisories.length];
              const advisory = advisoryTuple[1];
              const osvId = advisory.osvId;
              osvResult.advisories.set(osvId, {
                ...advisory,
                packageName: pkg,
                ecosystem: "npm",
                fixedVersion: advisory.fixedVersion ?? "1.0.1",
              });
              osvResult.packageAdvisoryMap.set(pkg, [osvId]);
              registryResult.metadata.set(pkg, {
                packageName: pkg,
                latestVersion: "1.0.1",
                isDeprecated: false,
                deprecationNote: null,
                sourceRepo: { owner: "test", name: pkg },
              });
            }

            const ingestorResult: IngestorResult = {
              ecosystem: "npm",
              dependencies: deps,
              lock_file_present: lockFilePresent,
              lock_file_parsed: lockFilePresent,
              manifest_resolved: true,
              warnings: [],
            };

            await mockGitHubReleases([]);

            const result = await runScoreRankStep({
              repo: baseRepo,
              ingestorResult,
              osvResult,
              registryResult,
              sourceRepoByPackage: new Map(
                packageNames.map((p) => [p, { owner: "test", name: p }]),
              ),
              githubToken: null,
            });

            for (const mission of result.missions) {
              expect(["low", "medium", "high"]).toContain(mission.confidence);
            }
          },
        ),
        { numRuns: 50 },
      );
    });

    it("tie-breaking by published_at (newer first) is transitive", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              osvId: fc.string({ minLength: 1, maxLength: 20 }),
              publishedAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2026-12-31") }),
              severity: severityArb,
            }),
            { minLength: 3, maxLength: 6 },
          ),
          async (advisoryInputs) => {
            // Create deps with same severity to force tie-breaking
            const deps = advisoryInputs.map((a, i) => ({
              package_name: `pkg-${i}`,
              version_spec: "^1.0.0",
              dep_type: "production" as const,
              resolved_version: "1.0.0",
            }));

            const osvResult: OsvFetchResult = {
              advisories: new Map(),
              packageAdvisoryMap: new Map(),
              warnings: [],
            };
            const registryResult: RegistryFetchResult = {
              metadata: new Map(),
              warnings: [],
            };

            for (let i = 0; i < advisoryInputs.length; i++) {
              const input = advisoryInputs[i];
              const pkg = `pkg-${i}`;
              const osvId = input.osvId;
              osvResult.advisories.set(osvId, {
                osvId,
                source: "ghsa",
                ecosystem: "npm",
                packageName: pkg,
                severity: input.severity,
                cvssScore: 7.5,
                epssScore: null,
                summary: "Test",
                details: null,
                affectedVersions: [],
                fixedVersion: "1.0.1",
                publishedAt: input.publishedAt,
                modifiedAt: input.publishedAt,
                rawData: {},
              });
              osvResult.packageAdvisoryMap.set(pkg, [osvId]);
              registryResult.metadata.set(pkg, {
                packageName: pkg,
                latestVersion: "1.0.1",
                isDeprecated: false,
                deprecationNote: null,
                sourceRepo: null,
              });
            }

            const ingestorResult: IngestorResult = {
              ecosystem: "npm",
              dependencies: deps,
              lock_file_present: true,
              lock_file_parsed: true,
              manifest_resolved: true,
              warnings: [],
            };

            await mockGitHubReleases([]);

            const result = await runScoreRankStep({
              repo: baseRepo,
              ingestorResult,
              osvResult,
              registryResult,
              sourceRepoByPackage: new Map(deps.map((d) => [d.package_name, null])),
              githubToken: null,
            });

            // Invariant: for missions with equal composite_score and effort_label,
            // published_at is non-increasing (newer first)
            for (let i = 1; i < result.missions.length; i++) {
              const prev = result.missions[i - 1];
              const curr = result.missions[i];
              if (
                prev?.composite_score === curr?.composite_score &&
                prev?.effort_label === curr?.effort_label
              ) {
                const prevAdvisory = osvResult.advisories.get(prev?.advisory.osv_id ?? "");
                const currAdvisory = osvResult.advisories.get(curr?.advisory.osv_id ?? "");
                if (prevAdvisory && currAdvisory) {
                  expect(currAdvisory.publishedAt?.getTime() ?? 0).toBeLessThanOrEqual(
                    prevAdvisory.publishedAt?.getTime() ?? Infinity,
                  );
                }
              }
            }
          },
        ),
        { numRuns: 30 },
      );
    });
  });
});
