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

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyze } from "./analyze.js";

let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "deptend-analyze-"));
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** Routes a mocked fetch call to canned responses by URL substring. */
function routedFetch(): typeof fetch {
  return vi.fn((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.includes("api.github.com/repos/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            full_name: "owner/repo",
            name: "repo",
            owner: { login: "owner" },
            default_branch: "main",
            description: "A test repo",
            stargazers_count: 100,
            open_issues_count: 5,
            topics: [],
            homepage: null,
          }),
          { status: 200 },
        ),
      );
    }

    if (url.includes("api.osv.dev/v1/querybatch")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [{ vulns: [{ id: "GHSA-test-1234", modified: "2026-01-01T00:00:00Z" }] }],
          }),
          { status: 200 },
        ),
      );
    }

    if (url.includes("api.osv.dev/v1/vulns/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "GHSA-test-1234",
            modified: "2026-01-01T00:00:00Z",
            published: "2025-12-01T00:00:00Z",
            summary: "Test vulnerability in vulnerable-pkg",
            severity: [{ type: "CVSS_V3", score: "9.8" }],
            affected: [
              {
                package: { name: "vulnerable-pkg", ecosystem: "npm" },
                ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }],
              },
            ],
          }),
          { status: 200 },
        ),
      );
    }

    if (url.includes("registry.npmjs.org/")) {
      return Promise.resolve(
        new Response(JSON.stringify({ version: "1.0.1", deprecated: undefined }), { status: 200 }),
      );
    }

    throw new Error(`Unmocked fetch call in analyze.test.ts: ${url}`);
  });
}

describe("analyze", () => {
  it("produces a ranked mission list from a local repo with a real vulnerability", async () => {
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ dependencies: { "vulnerable-pkg": "^1.0.0" } }),
    );
    vi.stubGlobal("fetch", routedFetch());

    const result = await analyze({
      repoPath: repoDir,
      githubOwner: "owner",
      githubName: "repo",
      githubToken: null,
    });

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
    await writeFile(
      join(repoDir, "pyproject.toml"),
      `[project]\ndependencies = ["vulnerable-pkg>=1.0.0"]\n`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        if (url.includes("api.github.com/repos/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                full_name: "owner/repo",
                name: "repo",
                owner: { login: "owner" },
                default_branch: "main",
                description: "A test repo",
                stargazers_count: 100,
                open_issues_count: 5,
                topics: [],
                homepage: null,
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes("api.osv.dev/v1/querybatch")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                results: [
                  { vulns: [{ id: "GHSA-test-pypi-1234", modified: "2026-01-01T00:00:00Z" }] },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes("api.osv.dev/v1/vulns/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "GHSA-test-pypi-1234",
                modified: "2026-01-01T00:00:00Z",
                published: "2025-12-01T00:00:00Z",
                summary: "Test vulnerability in vulnerable-pkg",
                severity: [{ type: "CVSS_V3", score: "9.8" }],
                affected: [
                  {
                    package: { name: "vulnerable-pkg", ecosystem: "PyPI" },
                    // ECOSYSTEM type, not SEMVER — the actual real shape
                    // OSV uses for PyPI (Step 6/ADR 0022). If the router
                    // somehow left ecosystem defaulted to npm instead of
                    // detecting pypi, this range would be silently dropped
                    // and fixed_version would come back null instead of
                    // "1.0.1" — this test would then fail on that
                    // assertion, not silently pass.
                    ranges: [
                      { type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.1" }] },
                    ],
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes("pypi.org/pypi/")) {
          return Promise.resolve(
            new Response(JSON.stringify({ info: { version: "1.0.1", name: "vulnerable-pkg" } }), {
              status: 200,
            }),
          );
        }
        throw new Error(`Unmocked fetch call in analyze.test.ts (pypi): ${url}`);
      }),
    );

    const result = await analyze({
      repoPath: repoDir,
      githubOwner: "owner",
      githubName: "repo",
      githubToken: null,
    });

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
    await writeFile(
      join(repoDir, "go.mod"),
      "module github.com/owner/repo\n\ngo 1.21\n\nrequire github.com/vulnerable/pkg v1.0.0\n",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        if (url.includes("api.github.com/repos/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                full_name: "owner/repo",
                name: "repo",
                owner: { login: "owner" },
                default_branch: "main",
                description: "A test repo",
                stargazers_count: 100,
                open_issues_count: 5,
                topics: [],
                homepage: null,
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes("api.osv.dev/v1/querybatch")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                results: [
                  { vulns: [{ id: "GHSA-test-go-1234", modified: "2026-01-01T00:00:00Z" }] },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes("api.osv.dev/v1/vulns/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "GHSA-test-go-1234",
                modified: "2026-01-01T00:00:00Z",
                published: "2025-12-01T00:00:00Z",
                summary: "Test vulnerability in github.com/vulnerable/pkg",
                severity: [{ type: "CVSS_V3", score: "9.8" }],
                affected: [
                  {
                    package: { name: "github.com/vulnerable/pkg", ecosystem: "Go" },
                    // SEMVER type — OSV's real shape for Go (unlike PyPI's
                    // ECOSYSTEM-type ranges), confirmed against vuln.go.dev
                    // during ADR 0024's own grounding. v-prefixed, matching
                    // real Go module version convention.
                    ranges: [
                      { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "v1.0.1" }] },
                    ],
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes("proxy.golang.org/")) {
          // All-lowercase module path here — no case-encoding to verify;
          // that's encodeGoModulePath()'s own unit tests' job. This just
          // confirms the CLI pipeline reaches the right host/shape.
          return Promise.resolve(
            new Response(JSON.stringify({ Version: "v1.0.1" }), { status: 200 }),
          );
        }
        throw new Error(`Unmocked fetch call in analyze.test.ts (go): ${url}`);
      }),
    );

    const result = await analyze({
      repoPath: repoDir,
      githubOwner: "owner",
      githubName: "repo",
      githubToken: null,
    });

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
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ dependencies: { "clean-pkg": "^1.0.0" } }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                full_name: "owner/repo",
                name: "repo",
                owner: { login: "owner" },
                default_branch: "main",
                description: null,
                stargazers_count: 0,
                open_issues_count: 0,
                homepage: null,
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes("api.osv.dev/v1/querybatch")) {
          return Promise.resolve(new Response(JSON.stringify({ results: [{}] }), { status: 200 }));
        }
        if (url.includes("registry.npmjs.org/")) {
          return Promise.resolve(new Response("", { status: 404 }));
        }
        throw new Error(`Unmocked fetch call: ${url}`);
      }),
    );

    const result = await analyze({
      repoPath: repoDir,
      githubOwner: "owner",
      githubName: "repo",
      githubToken: null,
    });

    expect(result.missions).toEqual([]);
    expect(result.dependencies_scanned).toBe(1);
  });

  it("still returns repo metadata and warnings when there's no manifest for any ecosystem", async () => {
    // repoDir intentionally left empty — no package.json, no
    // pyproject.toml, no requirements.txt. The router (npm first, per ADR
    // 0022) tries both and falls through to fully unresolved.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.github.com/repos/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                full_name: "owner/repo",
                name: "repo",
                owner: { login: "owner" },
                default_branch: "main",
                description: null,
                stargazers_count: 0,
                open_issues_count: 0,
                homepage: null,
              }),
              { status: 200 },
            ),
          );
        }
        throw new Error(`Unmocked fetch call: ${url}`);
      }),
    );

    const result = await analyze({
      repoPath: repoDir,
      githubOwner: "owner",
      githubName: "repo",
      githubToken: null,
    });

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
    // Two packages engineered to produce identical composite_score and
    // effort_label — same severity (medium, no CVSS so both fall back to
    // the same severity-based impact estimate), same dep_type, same
    // semver-bump shape (patch). ecosystem_value is identical automatically
    // since it's repo-level, not package-level. Only published_at differs.
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ dependencies: { "pkg-a": "^1.0.0", "pkg-b": "^1.0.0" } }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        if (url.includes("api.github.com/repos/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                full_name: "owner/repo",
                name: "repo",
                owner: { login: "owner" },
                default_branch: "main",
                description: null,
                stargazers_count: 10,
                open_issues_count: 2,
                topics: [],
                homepage: null,
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes("api.osv.dev/v1/querybatch")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                results: [
                  { vulns: [{ id: "GHSA-older-1111", modified: "2020-01-01T00:00:00Z" }] },
                  { vulns: [{ id: "GHSA-newer-2222", modified: "2025-01-01T00:00:00Z" }] },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes("api.osv.dev/v1/vulns/GHSA-older-1111")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "GHSA-older-1111",
                modified: "2020-01-01T00:00:00Z",
                published: "2020-01-01T00:00:00Z", // much older
                summary: "Older advisory",
                severity: [],
                affected: [
                  {
                    package: { name: "pkg-a", ecosystem: "npm" },
                    ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }],
                  },
                ],
                database_specific: { severity: "MODERATE" },
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes("api.osv.dev/v1/vulns/GHSA-newer-2222")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "GHSA-newer-2222",
                modified: "2025-01-01T00:00:00Z",
                published: "2025-01-01T00:00:00Z", // much newer
                summary: "Newer advisory",
                severity: [],
                affected: [
                  {
                    package: { name: "pkg-b", ecosystem: "npm" },
                    ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }],
                  },
                ],
                database_specific: { severity: "MODERATE" },
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes("registry.npmjs.org/")) {
          return Promise.resolve(new Response("", { status: 404 }));
        }
        throw new Error(`Unmocked fetch call: ${url}`);
      }),
    );

    const result = await analyze({
      repoPath: repoDir,
      githubOwner: "owner",
      githubName: "repo",
      githubToken: null,
    });

    expect(result.missions).toHaveLength(2);
    expect(result.missions[0]?.composite_score).toBe(result.missions[1]?.composite_score);
    expect(result.missions[0]?.effort_label).toBe(result.missions[1]?.effort_label);
    // Genuinely tied on both — published_at decides it, newest first.
    expect(result.missions[0]?.advisory.osv_id).toBe("GHSA-newer-2222");
    expect(result.missions[1]?.advisory.osv_id).toBe("GHSA-older-1111");
  });

  it("resolves real breaking-change signals end-to-end and clears breaking_change_signals_unavailable (ADR 0029)", async () => {
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ dependencies: { "vulnerable-pkg": "^1.0.0" } }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        if (url.includes("api.github.com/repos/vulnerable-org/vulnerable-pkg/releases")) {
          // Real pagination terminates once GitHub returns an empty page —
          // this mock must do the same, or fetchReleaseSignals never sees
          // an empty page and keeps re-requesting up to MAX_PAGES, each
          // time re-collecting the same single release as a "new" one.
          // "&page=1" (with the leading &), not "page=1" — "per_page=100"
          // itself contains "page=1" as a substring, which silently
          // matched every page and reproduced the exact bug this mock is
          // supposed to prevent, on the very first attempt at writing it.
          const isFirstPage = url.includes("&page=1");
          return Promise.resolve(
            new Response(
              JSON.stringify(
                isFirstPage
                  ? [
                      {
                        tag_name: "v1.0.1",
                        body: "BREAKING CHANGE: removed the deprecated foo() export.",
                        prerelease: false,
                        draft: false,
                      },
                    ]
                  : [],
              ),
              { status: 200 },
            ),
          );
        }
        if (url.includes("api.github.com/repos/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                full_name: "owner/repo",
                name: "repo",
                owner: { login: "owner" },
                default_branch: "main",
                description: "A test repo",
                stargazers_count: 100,
                open_issues_count: 5,
                topics: [],
                homepage: null,
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes("api.osv.dev/v1/querybatch")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                results: [{ vulns: [{ id: "GHSA-test-1234", modified: "2026-01-01T00:00:00Z" }] }],
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes("api.osv.dev/v1/vulns/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "GHSA-test-1234",
                modified: "2026-01-01T00:00:00Z",
                published: "2025-12-01T00:00:00Z",
                summary: "Test vulnerability in vulnerable-pkg",
                severity: [{ type: "CVSS_V3", score: "9.8" }],
                affected: [
                  {
                    package: { name: "vulnerable-pkg", ecosystem: "npm" },
                    ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }],
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes("registry.npmjs.org/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                version: "1.0.1",
                repository: "vulnerable-org/vulnerable-pkg",
              }),
              { status: 200 },
            ),
          );
        }
        throw new Error(`Unmocked fetch call in analyze.test.ts (ADR 0029): ${url}`);
      }),
    );

    const result = await analyze({
      repoPath: repoDir,
      githubOwner: "owner",
      githubName: "repo",
      githubToken: null,
    });

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
