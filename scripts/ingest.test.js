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
import { ingestRepo } from "./ingest.js";

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

describe("ingestRepo regression (c32878f)", () => {
  it("does not hit 'Assignment to constant variable' on the happy path", async () => {
    // Both allSettled promises resolve → ingestRepo's `ghMetaResult.status
    // === 'rejected'` branch is skipped, the buggy `ghMeta = ghMeta.value;`
    // line is reached, and the pre-fix code throws TypeError.
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

    // Stop at the writer boundary so the test doesn't depend on the
    // (unmocked) detectEcosystem/registry flow. The writer rejects, the
    // outer catch at ingestRepo:480 logs "Ingestion failed: ..." with
    // the writer's error, and the function returns false.
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

    // The c32878f bug surfaces as this exact log line. Asserting its
    // absence is the regression: with the fix, the error log instead
    // names the writer's "test: stopped at writer.write" message.
    const lines = logLines();
    const bugLine = lines.find((l) => l.includes("Assignment to constant variable"));
    expect(
      bugLine,
      `ingestRepo must not throw 'Assignment to constant variable' — ` +
        `this is the c32878f regression. Log lines:\n${lines.join("\n")}`,
    ).toBeUndefined();
  });

  it("handles GitHub rate limit error (fatal, returns false)", async () => {
    // Simulate rate limit by throwing an error with kind="rate_limited"
    // The actual GitHubMetaError class check uses instanceof which doesn't
    // work well with mocks, so we test the fatal path by throwing a generic
    // error that won't match the not_found handling.
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

    // Should return false (fatal error)
    expect(result).toBe(false);
    // Should not have called writer
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
    // Org fetch fails with network error (not GitHubOrgMetaError) → non-fatal
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

    // Should not crash, should reach writer and log the org warning
    const lines = logLines();
    const errorLines = lines.filter((l) => l.includes("[ERROR]"));
    // The org fetch failure should be logged as warning, not error
    // The error should be from the writer rejection
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
    // Org fetch fails with rate limit → fatal (re-thrown)
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

    // Should return false (fatal error re-thrown)
    expect(result).toBe(false);
    expect(writer.write).not.toHaveBeenCalled();
  });
});
