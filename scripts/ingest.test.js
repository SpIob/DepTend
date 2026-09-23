/**
 * Regression test for the c32878f "Assignment to constant variable" bug
 * (scripts/ingest.js:293).
 *
 * On 2026-08-30 09:40 UTC, the daily ingest cron (run 33304652258) failed
 * with a TypeError when re-ingesting psf/requests — a stale-complete repo
 * that hit the 7-day threshold for the first time since c32878f shipped.
 * The root cause: `const [ghMeta, orgResult] = await Promise.allSettled(...)`
 * on line 274 of ingestRepo was followed by `ghMeta = ghMeta.value;` on
 * line 293, which throws at runtime because the destructured `ghMeta`
 * binding is `const`.
 *
 * Test design (intentionally narrow per AGENTS.md §6's meta-lesson about
 * mocks-vs-real-path; the durable proof for this fix is the
 * workflow_dispatch live check against the deployed site, not this mock):
 *
 *   - Mock fetchGitHubRepoMeta + lookupGitHubOwnerMeta at the package
 *     boundary so the function reaches the buggy line.
 *   - Don't go further than necessary: the rest of ingestRepo's
 *     pipeline throws on the empty `{}` stubs we pass for the
 *     ingestors/writer anyway.
 *   - The outer try/catch inside ingestRepo swallows the TypeError and
 *     returns false. So `await expect(...).resolves.toBe(...)` is
 *     *vacuously green* for both the bug-present and bug-fixed paths,
 *     and would not catch a regression. Instead, the test spies on
 *     console.log and asserts the bug-specific log line never appears.
 *     With the bug, ingestRepo logs `[ERROR] Ingestion failed: Assignment
 *     to constant variable.`; with the fix, it logs the downstream
 *     "no registry fetcher" / "writer.write rejected" error instead.
 *
 * Why this file is .js (not .ts) and colocated in scripts/:
 *   - scripts/ingest.js is plain JS with no tsconfig; this file matches.
 *   - The file extension keeps the project's ESLint config from running
 *     typed-linting over a JS-only directory (which would need a tsconfig
 *     we deliberately don't have).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ingestRepo,
  resolvePending,
  resolveDueRepos,
  resolveById,
  resolveByUrl,
  parseArgs,
  argValue,
  intEnv,
} from "./ingest.js";

// Hoisted so the vi.mock factory closures can reach them.
const fetchGitHubRepoMetaMock = vi.hoisted(() => vi.fn());
const lookupGitHubOwnerMetaMock = vi.hoisted(() => vi.fn());

vi.mock("../packages/core/dist/ingestor/github-meta.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, fetchGitHubRepoMeta: fetchGitHubRepoMetaMock };
});

vi.mock("../packages/core/dist/ingestor/github-org-meta.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, lookupGitHubOwnerMeta: lookupGitHubOwnerMetaMock };
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Return every log line ingestRepo (or main()) emitted during the test. */
function logLines() {
  return console.log.mock.calls
    .map((args) => args.map(String).join(" "))
    .filter((line) => /^\[\d{4}-\d{2}-\d{2}T/.test(line));
}

/** Mock DB with configurable select/where behavior */
function createMockDb(selectResult = []) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(selectResult)),
        orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(selectResult)) })),
        limit: vi.fn(() => Promise.resolve(selectResult)),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
  };
}

describe("ingestRepo regression (c32878f)", () => {
  it("does not hit 'Assignment to constant variable' on the happy path", async () => {
    fetchGitHubRepoMetaMock.mockResolvedValue({
      full_name: "octocat/Hello-World",
      name: "Hello-World",
      owner: { login: "octocat" },
      default_branch: "main",
      description: null,
      stargazers_count: 0,
      open_issues_count: 0,
      topics: [],
      homepage: null,
    });
    lookupGitHubOwnerMetaMock.mockResolvedValue({
      login: "octocat",
      name: "Octo Org",
      avatarUrl: null,
      isOrg: true,
    });

    const writer = {
      write: vi.fn().mockRejectedValue(new Error("test: stopped at writer.write")),
    };

    await ingestRepo(
      { githubUrl: "https://github.com/octocat/Hello-World", submittedBy: null },
      /* db */ {},
      /* writer */ writer,
      /* missionWriter */ { generateMissionsForRepo: vi.fn() },
      /* npmIngestor */ {},
      /* pypiIngestor */ {},
      /* goIngestor */ {},
      /* osvFetcher */ { fetchAdvisories: vi.fn() },
      /* registryFetchersByEcosystem */ { npm: {}, pypi: {}, go: {} },
      /* githubToken */ null,
      /* librariesIoApiKey */ null,
      /* triggeredBy */ "manual",
    );

    const lines = logLines();
    const bugLine = lines.find((l) => l.includes("Assignment to constant variable"));
    expect(
      bugLine,
      `ingestRepo must not throw 'Assignment to constant variable' — ` +
        `this is the c32878f regression. Log lines:\n${lines.join("\n")}`,
    ).toBeUndefined();
  });

  it("handles GitHub rate limit error (fatal, returns false)", async () => {
    fetchGitHubRepoMetaMock.mockRejectedValue(new Error("Rate limited: 429"));
    lookupGitHubOwnerMetaMock.mockResolvedValue({
      login: "octocat",
      name: "Octo Org",
      avatarUrl: null,
      isOrg: true,
    });

    const writer = { write: vi.fn() };

    const result = await ingestRepo(
      { githubUrl: "https://github.com/octocat/Hello-World", submittedBy: null },
      {},
      writer,
      { generateMissionsForRepo: vi.fn() },
      {},
      {},
      {},
      { fetchAdvisories: vi.fn() },
      { npm: {}, pypi: {}, go: {} },
      null,
      null,
      "manual",
    );

    expect(result).toBe(false);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it("handles org metadata fetch failure (non-fatal, continues)", async () => {
    fetchGitHubRepoMetaMock.mockResolvedValue({
      full_name: "octocat/Hello-World",
      name: "Hello-World",
      owner: { login: "octocat" },
      default_branch: "main",
      description: null,
      stargazers_count: 0,
      open_issues_count: 0,
      topics: [],
      homepage: null,
    });
    lookupGitHubOwnerMetaMock.mockRejectedValue(new Error("Network error"));

    const writer = {
      write: vi.fn().mockRejectedValue(new Error("test: stopped at writer.write")),
    };

    await ingestRepo(
      { githubUrl: "https://github.com/octocat/Hello-World", submittedBy: null },
      /* db */ {},
      /* writer */ writer,
      /* missionWriter */ { generateMissionsForRepo: vi.fn() },
      /* npmIngestor */ {},
      /* pypiIngestor */ {},
      /* goIngestor */ {},
      /* osvFetcher */ { fetchAdvisories: vi.fn() },
      /* registryFetchersByEcosystem */ { npm: {}, pypi: {}, go: {} },
      /* githubToken */ null,
      /* librariesIoApiKey */ null,
      /* triggeredBy */ "manual",
    );

    const lines = logLines();
    const errorLines = lines.filter((l) => l.includes("[ERROR]"));
    expect(errorLines.length).toBeGreaterThanOrEqual(1);
  });

  it("handles org metadata rate limit (fatal)", async () => {
    fetchGitHubRepoMetaMock.mockResolvedValue({
      full_name: "octocat/Hello-World",
      name: "Hello-World",
      owner: { login: "octocat" },
      default_branch: "main",
      description: null,
      stargazers_count: 0,
      open_issues_count: 0,
      topics: [],
      homepage: null,
    });
    const { GitHubOrgMetaError } =
      await import("../packages/core/dist/ingestor/github-org-meta.js");
    lookupGitHubOwnerMetaMock.mockRejectedValue(
      new GitHubOrgMetaError("Rate limited", "rate_limited"),
    );

    const writer = { write: vi.fn() };

    const result = await ingestRepo(
      { githubUrl: "https://github.com/octocat/Hello-World", submittedBy: null },
      {},
      writer,
      { generateMissionsForRepo: vi.fn() },
      {},
      {},
      {},
      { fetchAdvisories: vi.fn() },
      { npm: {}, pypi: {}, go: {} },
      null,
      null,
      "manual",
    );

    expect(result).toBe(false);
    expect(writer.write).not.toHaveBeenCalled();
  });
});

describe("resolvePending", () => {
  it("returns pending and failed repos", async () => {
    const repos = [
      { id: "1", ingestionStatus: "pending" },
      { id: "2", ingestionStatus: "failed" },
      { id: "3", ingestionStatus: "complete" },
    ];
    const db = createMockDb(
      repos.filter((r) => r.ingestionStatus === "pending" || r.ingestionStatus === "failed"),
    );

    const result = await resolvePending(db);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("returns empty array when no pending/failed repos", async () => {
    const db = createMockDb([]);
    const result = await resolvePending(db);
    expect(result).toEqual([]);
  });
});

describe("resolveDueRepos", () => {
  it("returns pending/failed repos plus stale complete repos up to max", async () => {
    const now = Date.now();
    const staleCutoff = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    // const recentCutoff = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(); // unused

    const pendingFailedRepos = [
      { id: "1", ingestionStatus: "pending" },
      { id: "2", ingestionStatus: "failed" },
    ];
    const staleRepos = [
      { id: "3", ingestionStatus: "complete", lastIngestedAt: staleCutoff },
      { id: "5", ingestionStatus: "complete", lastIngestedAt: null },
    ];

    // Create a mock db that returns pending/failed for the first select (resolvePending)
    // and stale repos for the second select (staleComplete)
    let callCount = 0;
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            callCount++;
            if (callCount === 1) {
              // First call is resolvePending
              return Promise.resolve(pendingFailedRepos);
            }
            // Second call is staleComplete
            return {
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => Promise.resolve(staleRepos)),
              })),
            };
          }),
        })),
      })),
    };

    const result = await resolveDueRepos(db);
    expect(result).toHaveLength(4); // 2 pending/failed + 2 stale
    expect(result.map((r) => r.id).sort()).toEqual(["1", "2", "3", "5"]);
  });
});

describe("resolveById", () => {
  it("returns repo by UUID", async () => {
    const repo = { id: "test-id", ingestionStatus: "pending" };
    const db = createMockDb([repo]);

    const result = await resolveById(db, "test-id");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("test-id");
  });

  it("exits with code 1 when repo not found", async () => {
    const db = createMockDb([]);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
    await resolveById(db, "nonexistent");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe("resolveByUrl", () => {
  it("returns existing repo from DB", async () => {
    const repo = {
      githubUrl: "https://github.com/octocat/Hello-World",
      ingestionStatus: "complete",
    };
    const db = createMockDb([repo]);

    const result = await resolveByUrl(db, "https://github.com/octocat/Hello-World");
    expect(result).toHaveLength(1);
    expect(result[0].githubUrl).toBe("https://github.com/octocat/Hello-World");
  });

  it("normalizes URL (strips .git and trailing slash)", async () => {
    const repo = {
      githubUrl: "https://github.com/octocat/Hello-World",
      ingestionStatus: "complete",
    };
    const db = createMockDb([repo]);

    const result = await resolveByUrl(db, "https://github.com/octocat/Hello-World.git/");
    expect(result).toHaveLength(1);
    expect(result[0].githubUrl).toBe("https://github.com/octocat/Hello-World");
  });

  it("returns stub for new URL not in DB", async () => {
    const db = createMockDb([]);

    const result = await resolveByUrl(db, "https://github.com/new/repo");
    expect(result).toHaveLength(1);
    expect(result[0].githubUrl).toBe("https://github.com/new/repo");
    expect(result[0].submittedBy).toBeNull();
  });
});

describe("parseArgs", () => {
  it("defaults triggeredBy to cron", () => {
    const result = parseArgs([]);
    expect(result.triggeredBy).toBe("cron");
    expect(result.repoId).toBeNull();
    expect(result.repoUrl).toBeNull();
  });

  it("parses triggeredBy", () => {
    const result = parseArgs(["--triggered-by", "manual"]);
    expect(result.triggeredBy).toBe("manual");
  });

  it("parses repo-id", () => {
    const result = parseArgs(["--repo-id", "test-uuid"]);
    expect(result.repoId).toBe("test-uuid");
  });

  it("parses repo-url", () => {
    const result = parseArgs(["--repo-url", "https://github.com/octocat/Hello-World"]);
    expect(result.repoUrl).toBe("https://github.com/octocat/Hello-World");
  });

  it("exits with code 1 on invalid triggeredBy", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
    parseArgs(["--triggered-by", "invalid"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits with code 1 when both repo-id and repo-url provided", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
    parseArgs(["--repo-id", "test", "--repo-url", "https://github.com/octocat/Hello-World"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe("argValue", () => {
  it("returns value after flag", () => {
    expect(argValue(["--flag", "value"], "--flag")).toBe("value");
  });

  it("returns undefined for missing flag", () => {
    expect(argValue(["--other", "value"], "--flag")).toBeUndefined();
  });

  it("returns undefined when flag is last arg", () => {
    expect(argValue(["--flag"], "--flag")).toBeUndefined();
  });
});

describe("intEnv", () => {
  beforeEach(() => {
    vi.stubEnv("TEST_POSITIVE", "42");
    vi.stubEnv("TEST_ZERO", "0");
    vi.stubEnv("TEST_NEGATIVE", "-5");
    vi.stubEnv("TEST_NON_NUMERIC", "abc");
    vi.stubEnv("TEST_EMPTY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns parsed positive integer", () => {
    expect(intEnv("TEST_POSITIVE", 10)).toBe(42);
  });

  it("returns fallback for zero", () => {
    expect(intEnv("TEST_ZERO", 10)).toBe(10);
  });

  it("returns fallback for negative", () => {
    expect(intEnv("TEST_NEGATIVE", 10)).toBe(10);
  });

  it("returns fallback for non-numeric", () => {
    expect(intEnv("TEST_NON_NUMERIC", 10)).toBe(10);
  });

  it("returns fallback for empty string", () => {
    expect(intEnv("TEST_EMPTY", 10)).toBe(10);
  });

  it("returns fallback for unset", () => {
    expect(intEnv("TEST_UNSET", 10)).toBe(10);
  });
});
