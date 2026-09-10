/**
 * runScoreRankStep unit tests
 *
 * Tests the scoring, copy generation, effort signal prefetching, and ranking step in isolation.
 * Mocks external calls (GitHub releases) while exercising the pure scoring functions.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runScoreRankStep } from "./score-rank-step.js";
import type { Repo } from "@deptend/core/db/schema.js";
import type { IngestorResult } from "@deptend/core/pipeline/ecosystem-detection.js";
import type { OsvFetchResult } from "@deptend/core/ingestor/osv.js";
import type { RegistryFetchResult } from "@deptend/core/ingestor/registry-base.js";
import type { PackageMetadata } from "@deptend/core/pipeline/registry-fetchers.js";
import { buildRepo } from "../build-rows.js";
import type { GitHubRepoMeta } from "@deptend/core/ingestor/github-meta.js";

describe("runScoreRankStep", () => {
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

  // Dependency with resolved_version from lock file
  const baseIngestorResult: IngestorResult = {
    ecosystem: "npm",
    dependencies: [
      {
        package_name: "vulnerable-pkg",
        version_spec: "^1.0.0",
        dep_type: "production",
        resolved_version: "1.0.0", // From lock file
      },
    ],
    lock_file_present: true,
    lock_file_parsed: true,
    manifest_resolved: true,
    warnings: [],
  };

  const baseOsvResult: OsvFetchResult = {
    advisories: new Map([
      [
        "GHSA-test-1234",
        {
          osvId: "GHSA-test-1234",
          source: "ghsa",
          ecosystem: "npm",
          packageName: "vulnerable-pkg",
          severity: "critical",
          cvssScore: 9.8,
          epssScore: null,
          summary: "Test vulnerability in vulnerable-pkg",
          details: null,
          affectedVersions: [],
          fixedVersion: "1.0.1",
          publishedAt: new Date("2025-12-01T00:00:00Z"),
          modifiedAt: new Date("2026-01-01T00:00:00Z"),
          rawData: {},
        },
      ],
    ]),
    packageAdvisoryMap: new Map([["vulnerable-pkg", ["GHSA-test-1234"]]]),
    warnings: [],
  };

  const baseRegistryResult: RegistryFetchResult = {
    metadata: new Map([
      [
        "vulnerable-pkg",
        {
          packageName: "vulnerable-pkg",
          latestVersion: "1.0.1",
          isDeprecated: false,
          deprecationNote: null,
          sourceRepo: { host: "github.com", owner: "vulnerable-org", name: "vulnerable-pkg" },
        },
      ],
    ]),
    warnings: [],
  };

  const baseSourceRepoByPackage = new Map<string, PackageMetadata["sourceRepo"] | null>([
    ["vulnerable-pkg", { owner: "vulnerable-org", name: "vulnerable-pkg" }],
  ]);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("produces a ranked mission for a single vulnerable dependency", async () => {
    // Mock GitHub releases - empty = no signals found (but source was available)
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.github.com/repos/vulnerable-org/vulnerable-pkg/releases")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`Unmocked fetch in test: ${url}`);
    });

    const result = await runScoreRankStep({
      repo: baseRepo,
      ingestorResult: baseIngestorResult,
      osvResult: baseOsvResult,
      registryResult: baseRegistryResult,
      sourceRepoByPackage: baseSourceRepoByPackage,
      githubToken: null,
    });

    expect(result.missions).toHaveLength(1);
    const mission = result.missions[0];
    expect(mission?.dependency.package_name).toBe("vulnerable-pkg");
    expect(mission?.advisory.osv_id).toBe("GHSA-test-1234");
    expect(mission?.advisory.severity).toBe("critical");
    expect(mission?.advisory.fixed_version).toBe("1.0.1");
    expect(mission?.composite_score).toBeGreaterThan(0);
    // Lock file present + downstream unavailable = 1 flag = medium confidence
    expect(mission?.confidence).toBe("medium");
    expect(result.dependenciesScanned).toBe(1);
    expect(result.ecosystem).toBe("npm");
    expect(result.lockFilePresent).toBe(true);
  });

  it("produces low confidence when no lock file", async () => {
    const noLockIngestorResult: IngestorResult = {
      ...baseIngestorResult,
      dependencies: [
        {
          package_name: "vulnerable-pkg",
          version_spec: "^1.0.0",
          dep_type: "production",
          resolved_version: null, // No lock file
        },
      ],
      lock_file_present: false,
      lock_file_parsed: false,
    };

    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.github.com/repos/")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    });

    const result = await runScoreRankStep({
      repo: baseRepo,
      ingestorResult: noLockIngestorResult,
      osvResult: baseOsvResult,
      registryResult: baseRegistryResult,
      sourceRepoByPackage: baseSourceRepoByPackage,
      githubToken: null,
    });

    expect(result.missions[0]?.confidence).toBe("low");
  });

  it("includes OSV and registry warnings in output", async () => {
    const osvWithWarnings: OsvFetchResult = {
      ...baseOsvResult,
      warnings: ["OSV detail fetch failed for GHSA-xxxx"],
    };
    const registryWithWarnings: RegistryFetchResult = {
      ...baseRegistryResult,
      warnings: ["npm registry rate limited"],
    };

    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.github.com/repos/")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    });

    const result = await runScoreRankStep({
      repo: baseRepo,
      ingestorResult: baseIngestorResult,
      osvResult: osvWithWarnings,
      registryResult: registryWithWarnings,
      sourceRepoByPackage: baseSourceRepoByPackage,
      githubToken: null,
    });

    expect(result.warnings).toContain("OSV detail fetch failed for GHSA-xxxx");
    expect(result.warnings).toContain("npm registry rate limited");
  });

  describe("effort signal prefetching (ADR 0029)", () => {
    it("fetches breaking change signals from GitHub releases when available", async () => {
      // Return a release at v1.0.1 (the fixed version) with breaking change
      // Version range: floor="1.0.0" (from ^1.0.0), target="1.0.1" (fixedVersion)
      // Releases in range: > 1.0.0 and <= 1.0.1
      // The signal extraction captures bullet points in "## Breaking Changes" section as-is
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/vulnerable-org/vulnerable-pkg/releases")) {
          return new Response(
            JSON.stringify([
              {
                tag_name: "v1.0.1",
                body: "## Breaking Changes\n- BREAKING CHANGE: removed deprecated API\n\n## Migration Guide\nSee migration guide for details.",
                prerelease: false,
                draft: false,
              },
            ]),
            { status: 200 },
          );
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: baseIngestorResult,
        osvResult: baseOsvResult,
        registryResult: baseRegistryResult,
        sourceRepoByPackage: baseSourceRepoByPackage,
        githubToken: null,
      });

      const mission = result.missions[0];
      // The signal captures the full bullet point text including "BREAKING CHANGE:" prefix
      expect(mission?.scoring_inputs.effort.breaking_change_signals).toContain(
        "BREAKING CHANGE: removed deprecated API",
      );
      expect(mission?.scoring_inputs.effort.has_migration_guide).toBe(true);
      // source_available should be true (received releases page), so breaking_change_signals_unavailable flag should NOT be set
      expect(mission?.confidence_notes).not.toContain(
        "Changelog and migration-guide data wasn't available for this dependency's own upstream repository, so the effort estimate is based on the semver version bump alone.",
      );
      // With lock file + downstream unavailable + breaking changes available = 1 flag = medium
      expect(mission?.confidence).toBe("medium");
    });

    it("handles missing source repo gracefully (source_available = false)", async () => {
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: baseIngestorResult,
        osvResult: baseOsvResult,
        registryResult: {
          ...baseRegistryResult,
          metadata: new Map([
            [
              "vulnerable-pkg",
              {
                packageName: "vulnerable-pkg",
                latestVersion: "1.0.1",
                isDeprecated: false,
                deprecationNote: null,
                sourceRepo: null,
              },
            ],
          ]),
          warnings: [],
        },
        sourceRepoByPackage: new Map([["vulnerable-pkg", null]]),
        githubToken: null,
      });

      const mission = result.missions[0];
      expect(mission?.scoring_inputs.effort.breaking_change_signals).toEqual([]);
      expect(mission?.scoring_inputs.effort.has_migration_guide).toBe(false);
      // source_available = false (no source repo), so breaking_change_signals_unavailable flag IS set
      expect(mission?.confidence_notes).toContain(
        "Changelog and migration-guide data wasn't available for this dependency's own upstream repository, so the effort estimate is based on the semver version bump alone.",
      );
      // Lock file present + downstream unavailable + breaking_change_signals_unavailable = 2 flags = low
      expect(mission?.confidence).toBe("low");
    });

    it("handles GitHub releases pagination", async () => {
      // Page 1 has v1.0.2 (newer than target 1.0.1 - skipped) and v1.0.1 (in range, has breaking change)
      // Page 2 has v1.0.0 (at floor - stops pagination)
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/vulnerable-org/vulnerable-pkg/releases")) {
          const isPage1 = url.includes("page=1") || !url.includes("page=");
          if (isPage1) {
            return new Response(
              JSON.stringify([
                { tag_name: "v1.0.2", body: "Minor fix", prerelease: false, draft: false },
                {
                  tag_name: "v1.0.1",
                  body: "## Breaking Changes\n- BREAKING: major refactor\n\n## Migration Guide\nSee upgrading guide.",
                  prerelease: false,
                  draft: false,
                },
              ]),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify([
              { tag_name: "v1.0.0", body: "Initial release", prerelease: false, draft: false },
            ]),
            { status: 200 },
          );
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: baseIngestorResult,
        osvResult: baseOsvResult,
        registryResult: baseRegistryResult,
        sourceRepoByPackage: baseSourceRepoByPackage,
        githubToken: null,
      });

      const mission = result.missions[0];
      // The signal captures the full bullet point text
      expect(mission?.scoring_inputs.effort.breaking_change_signals).toContain(
        "BREAKING: major refactor",
      );
      expect(mission?.scoring_inputs.effort.has_migration_guide).toBe(true);
    });

    it("handles GitHub API 404 (repo not found or no releases)", async () => {
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: baseIngestorResult,
        osvResult: baseOsvResult,
        registryResult: baseRegistryResult,
        sourceRepoByPackage: baseSourceRepoByPackage,
        githubToken: null,
      });

      const mission = result.missions[0];
      // 404 returns UNAVAILABLE_SIGNALS
      expect(mission?.scoring_inputs.effort.breaking_change_signals).toEqual([]);
      expect(mission?.scoring_inputs.effort.has_migration_guide).toBe(false);
      expect(mission?.confidence_notes).toContain(
        "Changelog and migration-guide data wasn't available for this dependency's own upstream repository, so the effort estimate is based on the semver version bump alone.",
      );
    });

    it("handles releases with no breaking changes in range", async () => {
      // Release at v1.0.1 but no breaking changes in body
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/vulnerable-org/vulnerable-pkg/releases")) {
          return new Response(
            JSON.stringify([
              {
                tag_name: "v1.0.1",
                body: "Bug fixes and improvements",
                prerelease: false,
                draft: false,
              },
            ]),
            { status: 200 },
          );
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: baseIngestorResult,
        osvResult: baseOsvResult,
        registryResult: baseRegistryResult,
        sourceRepoByPackage: baseSourceRepoByPackage,
        githubToken: null,
      });

      const mission = result.missions[0];
      expect(mission?.scoring_inputs.effort.breaking_change_signals).toEqual([]);
      expect(mission?.scoring_inputs.effort.has_migration_guide).toBe(false);
      // But source_available = true (checked and found nothing)
      expect(mission?.confidence_notes).not.toContain(
        "Changelog and migration-guide data wasn't available for this dependency's own upstream repository, so the effort estimate is based on the semver version bump alone.",
      );
      // Lock file present + downstream unavailable = 1 flag = medium
      expect(mission?.confidence).toBe("medium");
    });
  });

  describe("ranking and tie-breaking", () => {
    it("ranks multiple missions by composite score descending", async () => {
      const multiOsvResult: OsvFetchResult = {
        advisories: new Map([
          [
            "GHSA-low",
            {
              osvId: "GHSA-low",
              source: "ghsa",
              ecosystem: "npm",
              packageName: "pkg-low",
              severity: "low",
              cvssScore: 3.0,
              epssScore: null,
              summary: "Low",
              details: null,
              affectedVersions: [],
              fixedVersion: "1.0.1",
              publishedAt: new Date("2025-12-01T00:00:00Z"),
              modifiedAt: new Date("2026-01-01T00:00:00Z"),
              rawData: {},
            },
          ],
          [
            "GHSA-high",
            {
              osvId: "GHSA-high",
              source: "ghsa",
              ecosystem: "npm",
              packageName: "pkg-high",
              severity: "critical",
              cvssScore: 9.8,
              epssScore: null,
              summary: "High",
              details: null,
              affectedVersions: [],
              fixedVersion: "2.0.1",
              publishedAt: new Date("2025-12-01T00:00:00Z"),
              modifiedAt: new Date("2026-01-01T00:00:00Z"),
              rawData: {},
            },
          ],
        ]),
        packageAdvisoryMap: new Map([
          ["pkg-low", ["GHSA-low"]],
          ["pkg-high", ["GHSA-high"]],
        ]),
        warnings: [],
      };

      const multiIngestorResult: IngestorResult = {
        ...baseIngestorResult,
        dependencies: [
          {
            package_name: "pkg-low",
            version_spec: "^1.0.0",
            dep_type: "production",
            resolved_version: "1.0.0",
          },
          {
            package_name: "pkg-high",
            version_spec: "^2.0.0",
            dep_type: "production",
            resolved_version: "2.0.0",
          },
        ],
      };

      const multiRegistryResult: RegistryFetchResult = {
        metadata: new Map([
          [
            "pkg-low",
            {
              packageName: "pkg-low",
              latestVersion: "1.0.1",
              isDeprecated: false,
              deprecationNote: null,
              sourceRepo: null,
            },
          ],
          [
            "pkg-high",
            {
              packageName: "pkg-high",
              latestVersion: "2.0.1",
              isDeprecated: false,
              deprecationNote: null,
              sourceRepo: null,
            },
          ],
        ]),
        warnings: [],
      };

      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: multiIngestorResult,
        osvResult: multiOsvResult,
        registryResult: multiRegistryResult,
        sourceRepoByPackage: new Map([
          ["pkg-low", null],
          ["pkg-high", null],
        ]),
        githubToken: null,
      });

      expect(result.missions).toHaveLength(2);
      // Higher severity should rank first
      expect(result.missions[0]?.advisory.osv_id).toBe("GHSA-high");
      expect(result.missions[1]?.advisory.osv_id).toBe("GHSA-low");
      expect(result.missions[0]?.composite_score).toBeGreaterThan(
        result.missions[1]?.composite_score ?? 0,
      );
    });

    it("breaks ties by published_at (newest first) then osv_id", async () => {
      // Same severity, same score - tie break by published_at
      const tieOsvResult: OsvFetchResult = {
        advisories: new Map([
          [
            "GHSA-older-1111",
            {
              osvId: "GHSA-older-1111",
              source: "ghsa",
              ecosystem: "npm",
              packageName: "pkg-a",
              severity: "high",
              cvssScore: 7.5,
              epssScore: null,
              summary: "Older",
              details: null,
              affectedVersions: [],
              fixedVersion: "1.0.1",
              publishedAt: new Date("2020-01-01T00:00:00Z"),
              modifiedAt: new Date("2020-01-01T00:00:00Z"),
              rawData: {},
            },
          ],
          [
            "GHSA-newer-2222",
            {
              osvId: "GHSA-newer-2222",
              source: "ghsa",
              ecosystem: "npm",
              packageName: "pkg-b",
              severity: "high",
              cvssScore: 7.5,
              epssScore: null,
              summary: "Newer",
              details: null,
              affectedVersions: [],
              fixedVersion: "1.0.1",
              publishedAt: new Date("2025-01-01T00:00:00Z"),
              modifiedAt: new Date("2025-01-01T00:00:00Z"),
              rawData: {},
            },
          ],
        ]),
        packageAdvisoryMap: new Map([
          ["pkg-a", ["GHSA-older-1111"]],
          ["pkg-b", ["GHSA-newer-2222"]],
        ]),
        warnings: [],
      };

      const tieIngestorResult: IngestorResult = {
        ...baseIngestorResult,
        dependencies: [
          {
            package_name: "pkg-a",
            version_spec: "^1.0.0",
            dep_type: "production",
            resolved_version: "1.0.0",
          },
          {
            package_name: "pkg-b",
            version_spec: "^1.0.0",
            dep_type: "production",
            resolved_version: "1.0.0",
          },
        ],
      };

      const tieRegistryResult: RegistryFetchResult = {
        metadata: new Map([
          [
            "pkg-a",
            {
              packageName: "pkg-a",
              latestVersion: "1.0.1",
              isDeprecated: false,
              deprecationNote: null,
              sourceRepo: null,
            },
          ],
          [
            "pkg-b",
            {
              packageName: "pkg-b",
              latestVersion: "1.0.1",
              isDeprecated: false,
              deprecationNote: null,
              sourceRepo: null,
            },
          ],
        ]),
        warnings: [],
      };

      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: tieIngestorResult,
        osvResult: tieOsvResult,
        registryResult: tieRegistryResult,
        sourceRepoByPackage: new Map([
          ["pkg-a", null],
          ["pkg-b", null],
        ]),
        githubToken: null,
      });

      expect(result.missions).toHaveLength(2);
      expect(result.missions[0]?.composite_score).toBe(result.missions[1]?.composite_score);
      // Newer published_at should rank first
      expect(result.missions[0]?.advisory.osv_id).toBe("GHSA-newer-2222");
      expect(result.missions[1]?.advisory.osv_id).toBe("GHSA-older-1111");
    });
  });

  describe("confidence levels", () => {
    it("sets confidence to medium when lock file present AND breaking changes available", async () => {
      // Return releases with breaking changes so source_available = true
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/vulnerable-org/vulnerable-pkg/releases")) {
          return new Response(
            JSON.stringify([
              {
                tag_name: "v1.0.1",
                body: "## Breaking Changes\n- BREAKING CHANGE: removed deprecated API\n\n## Migration Guide\nSee migration guide for details.",
                prerelease: false,
                draft: false,
              },
            ]),
            { status: 200 },
          );
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: baseIngestorResult,
        osvResult: baseOsvResult,
        registryResult: baseRegistryResult,
        sourceRepoByPackage: baseSourceRepoByPackage,
        githubToken: null,
      });

      // CLI doesn't fetch downstream dependents, so downstream_dependents_unavailable is ALWAYS set
      // With lock file: no_lock_file = false
      // With breaking changes available: breaking_change_signals_unavailable = false
      // That's 1 flag (downstream_dependents_unavailable) = medium
      expect(result.missions[0]?.confidence).toBe("medium");
    });

    it("sets confidence to low when no lock file (downstream unavailable + no lock file = 2 flags)", async () => {
      const noLockIngestorResult: IngestorResult = {
        ...baseIngestorResult,
        dependencies: [
          {
            package_name: "vulnerable-pkg",
            version_spec: "^1.0.0",
            dep_type: "production",
            resolved_version: null, // No lock file
          },
        ],
        lock_file_present: false,
        lock_file_parsed: false,
      };

      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: noLockIngestorResult,
        osvResult: baseOsvResult,
        registryResult: baseRegistryResult,
        sourceRepoByPackage: baseSourceRepoByPackage,
        githubToken: null,
      });

      // No lock file + downstream unavailable = 2 flags = low
      expect(result.missions[0]?.confidence).toBe("low");
    });

    it("sets confidence to low when effort signals unavailable (adds breaking_change_signals_unavailable flag)", async () => {
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: baseIngestorResult,
        osvResult: baseOsvResult,
        registryResult: {
          ...baseRegistryResult,
          metadata: new Map([
            [
              "vulnerable-pkg",
              {
                packageName: "vulnerable-pkg",
                latestVersion: "1.0.1",
                isDeprecated: false,
                deprecationNote: null,
                sourceRepo: null,
              },
            ],
          ]),
          warnings: [],
        },
        sourceRepoByPackage: new Map([["vulnerable-pkg", null]]),
        githubToken: null,
      });

      // Lock file present, but downstream unavailable + breaking_change_signals_unavailable = 2 flags = low
      expect(result.missions[0]?.confidence).toBe("low");
    });

    it("sets confidence to medium when lock file present but no breaking changes in range", async () => {
      // Release exists but no breaking changes
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/vulnerable-org/vulnerable-pkg/releases")) {
          return new Response(
            JSON.stringify([
              {
                tag_name: "v1.0.1",
                body: "Bug fixes only",
                prerelease: false,
                draft: false,
              },
            ]),
            { status: 200 },
          );
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: baseIngestorResult,
        osvResult: baseOsvResult,
        registryResult: baseRegistryResult,
        sourceRepoByPackage: baseSourceRepoByPackage,
        githubToken: null,
      });

      // Lock file present + downstream unavailable = but source_available = true, so
      // breaking_change_signals_unavailable = false; 1 flag = medium
      expect(result.missions[0]?.confidence).toBe("medium");
    });
  });

  describe("different dep types create separate missions", () => {
    it("creates separate missions for production and dev dependency of same package", async () => {
      const multiTypeIngestorResult: IngestorResult = {
        ...baseIngestorResult,
        dependencies: [
          {
            package_name: "lodash",
            version_spec: "^4.0.0",
            dep_type: "production",
            resolved_version: "4.0.0",
          },
          {
            package_name: "lodash",
            version_spec: "^4.0.0",
            dep_type: "development",
            resolved_version: "4.0.0",
          },
        ],
      };

      const multiTypeOsvResult: OsvFetchResult = {
        advisories: new Map([
          [
            "GHSA-test-1234",
            {
              osvId: "GHSA-test-1234",
              source: "ghsa",
              ecosystem: "npm",
              packageName: "lodash",
              severity: "high",
              cvssScore: 7.5,
              epssScore: null,
              summary: "Test",
              details: null,
              affectedVersions: [],
              fixedVersion: "4.17.21",
              publishedAt: new Date("2025-12-01T00:00:00Z"),
              modifiedAt: new Date("2026-01-01T00:00:00Z"),
              rawData: {},
            },
          ],
        ]),
        packageAdvisoryMap: new Map([["lodash", ["GHSA-test-1234"]]]),
        warnings: [],
      };

      const multiTypeRegistryResult: RegistryFetchResult = {
        metadata: new Map([
          [
            "lodash",
            {
              packageName: "lodash",
              latestVersion: "4.17.21",
              isDeprecated: false,
              deprecationNote: null,
              sourceRepo: null,
            },
          ],
        ]),
        warnings: [],
      };

      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: multiTypeIngestorResult,
        osvResult: multiTypeOsvResult,
        registryResult: multiTypeRegistryResult,
        sourceRepoByPackage: new Map([["lodash", null]]),
        githubToken: null,
      });

      expect(result.missions).toHaveLength(2);
      const depTypes = result.missions.map((m) => m.dependency.dep_type).sort();
      expect(depTypes).toEqual(["development", "production"]);
    });
  });

  describe("ecosystem-specific scoring", () => {
    it("produces missions for PyPI ecosystem", async () => {
      const pypiIngestorResult: IngestorResult = {
        ...baseIngestorResult,
        ecosystem: "pypi",
        dependencies: [
          {
            package_name: "requests",
            version_spec: ">=2.25",
            dep_type: "production",
            resolved_version: "2.25.0",
          },
        ],
      };

      const pypiOsvResult: OsvFetchResult = {
        advisories: new Map([
          [
            "GHSA-pypi-123",
            {
              osvId: "GHSA-pypi-123",
              source: "ghsa",
              ecosystem: "pypi",
              packageName: "requests",
              severity: "high",
              cvssScore: 7.5,
              epssScore: null,
              summary: "PyPI vuln",
              details: null,
              affectedVersions: [],
              fixedVersion: "2.28.0",
              publishedAt: new Date("2025-12-01T00:00:00Z"),
              modifiedAt: new Date("2026-01-01T00:00:00Z"),
              rawData: {},
            },
          ],
        ]),
        packageAdvisoryMap: new Map([["requests", ["GHSA-pypi-123"]]]),
        warnings: [],
      };

      const pypiRegistryResult: RegistryFetchResult = {
        metadata: new Map([
          [
            "requests",
            {
              packageName: "requests",
              latestVersion: "2.28.0",
              isDeprecated: false,
              deprecationNote: null,
              sourceRepo: null,
            },
          ],
        ]),
        warnings: [],
      };

      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: pypiIngestorResult,
        osvResult: pypiOsvResult,
        registryResult: pypiRegistryResult,
        sourceRepoByPackage: new Map([["requests", null]]),
        githubToken: null,
      });

      expect(result.missions).toHaveLength(1);
      expect(result.missions[0]?.advisory.source).toBe("ghsa");
      expect(result.missions[0]?.dependency.package_name).toBe("requests");
      expect(result.ecosystem).toBe("pypi");
    });

    it("produces missions for Go ecosystem", async () => {
      const goIngestorResult: IngestorResult = {
        ...baseIngestorResult,
        ecosystem: "go",
        dependencies: [
          {
            package_name: "github.com/vulnerable/pkg",
            version_spec: "v1.0.0",
            dep_type: "production",
            resolved_version: "v1.0.0",
          },
        ],
      };

      const goOsvResult: OsvFetchResult = {
        advisories: new Map([
          [
            "GHSA-go-123",
            {
              osvId: "GHSA-go-123",
              source: "ghsa",
              ecosystem: "go",
              packageName: "github.com/vulnerable/pkg",
              severity: "critical",
              cvssScore: 9.8,
              epssScore: null,
              summary: "Go vuln",
              details: null,
              affectedVersions: [],
              fixedVersion: "v1.0.1",
              publishedAt: new Date("2025-12-01T00:00:00Z"),
              modifiedAt: new Date("2026-01-01T00:00:00Z"),
              rawData: {},
            },
          ],
        ]),
        packageAdvisoryMap: new Map([["github.com/vulnerable/pkg", ["GHSA-go-123"]]]),
        warnings: [],
      };

      const goRegistryResult: RegistryFetchResult = {
        metadata: new Map([
          [
            "github.com/vulnerable/pkg",
            {
              packageName: "github.com/vulnerable/pkg",
              latestVersion: "v1.0.1",
              isDeprecated: false,
              deprecationNote: null,
              sourceRepo: null,
            },
          ],
        ]),
        warnings: [],
      };

      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: goIngestorResult,
        osvResult: goOsvResult,
        registryResult: goRegistryResult,
        sourceRepoByPackage: new Map([["github.com/vulnerable/pkg", null]]),
        githubToken: null,
      });

      expect(result.missions).toHaveLength(1);
      expect(result.missions[0]?.dependency.package_name).toBe("github.com/vulnerable/pkg");
      expect(result.ecosystem).toBe("go");
    });
  });

  describe("no vulnerable dependencies", () => {
    it("returns empty missions array when no advisories match", async () => {
      const cleanOsvResult: OsvFetchResult = {
        advisories: new Map(),
        packageAdvisoryMap: new Map(),
        warnings: [],
      };

      const cleanIngestorResult: IngestorResult = {
        ...baseIngestorResult,
        dependencies: [
          {
            package_name: "clean-pkg",
            version_spec: "^1.0.0",
            dep_type: "production",
            resolved_version: "1.0.0",
          },
        ],
      };

      const cleanRegistryResult: RegistryFetchResult = {
        metadata: new Map([
          [
            "clean-pkg",
            {
              packageName: "clean-pkg",
              latestVersion: "1.0.0",
              isDeprecated: false,
              deprecationNote: null,
              sourceRepo: null,
            },
          ],
        ]),
        warnings: [],
      };

      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });

      const result = await runScoreRankStep({
        repo: baseRepo,
        ingestorResult: cleanIngestorResult,
        osvResult: cleanOsvResult,
        registryResult: cleanRegistryResult,
        sourceRepoByPackage: new Map([["clean-pkg", null]]),
        githubToken: null,
      });

      expect(result.missions).toEqual([]);
      expect(result.dependenciesScanned).toBe(1);
    });
  });
});
