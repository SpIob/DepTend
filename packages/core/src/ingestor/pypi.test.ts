/**
 * PyPIIngestor unit tests
 *
 * Uses Vitest's built-in fetch mocking via vi.stubGlobal so no network
 * calls are made — same approach as npm.test.ts. Dependency-parsing edge
 * cases (PEP 508, extras, markers, the pyproject/requirements fallback
 * rule) are already thoroughly covered directly in pypi-parse.test.ts —
 * these tests focus on what's actually new here: fetching two manifest
 * URLs, wiring the fallback correctly, and detecting lock files remotely.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PyPIIngestor } from "./pypi.js";
import { BASE, lockUrl, mockFetch } from "./test-helpers.js";

function pyprojectUrl(base = BASE): string {
  return `${base}/pyproject.toml`;
}

function requirementsUrl(base = BASE): string {
  return `${base}/requirements.txt`;
}

/** All three Python lock files reporting absent — the common case */
function noLockFiles(base = BASE): Record<string, { status: number }> {
  return {
    [lockUrl("poetry.lock", base)]: { status: 404 },
    [lockUrl("Pipfile.lock", base)]: { status: 404 },
    [lockUrl("pdm.lock", base)]: { status: 404 },
  };
}

describe("PyPIIngestor", () => {
  let ingestor: PyPIIngestor;

  beforeEach(() => {
    // Transport backoff/deadline disabled — failure-path tests below stub a
    // rejecting fetch and must not sleep through the real 30 s policy.
    ingestor = new PyPIIngestor({ retryDelayMs: 0, timeoutMs: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has the correct ecosystem property", () => {
    expect(ingestor.ecosystem).toBe("pypi");
  });

  describe("parseDependencies — happy path", () => {
    it("parses dependencies from pyproject.toml when present", async () => {
      const toml = `
[project]
dependencies = ["requests>=2.25"]
`;
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [pyprojectUrl()]: { status: 200, body: toml },
          [requirementsUrl()]: { status: 404 },
          ...noLockFiles(),
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.ecosystem).toBe("pypi");
      expect(result.manifest_resolved).toBe(true);
      expect(result.dependencies).toEqual([
        { package_name: "requests", version_spec: ">=2.25", dep_type: "production" },
      ]);
    });

    it("falls back to requirements.txt when pyproject.toml is 404", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [pyprojectUrl()]: { status: 404 },
          [requirementsUrl()]: { status: 200, body: "click==8.1.0\n" },
          ...noLockFiles(),
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.manifest_resolved).toBe(true);
      expect(result.dependencies).toEqual([
        { package_name: "click", version_spec: "==8.1.0", dep_type: "production" },
      ]);
    });

    it("fetches pyproject.toml and requirements.txt unconditionally, even when pyproject.toml alone resolves", async () => {
      const toml = `[project]\ndependencies = ["requests>=2.25"]\n`;
      const fetchMock = mockFetch({
        [pyprojectUrl()]: { status: 200, body: toml },
        [requirementsUrl()]: { status: 200, body: "click==8.1.0\n" },
        ...noLockFiles(),
      });
      vi.stubGlobal("fetch", fetchMock);

      await ingestor.parseDependencies(BASE);

      // Both were fetched (deliberate simplicity choice, see pypi.ts docstring)
      expect(fetchMock).toHaveBeenCalledWith(requirementsUrl(), expect.anything());
    });
  });

  describe("parseDependencies — lock file detection", () => {
    it("detects poetry.lock presence", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [pyprojectUrl()]: { status: 200, body: `[project]\ndependencies = []\n` },
          [requirementsUrl()]: { status: 404 },
          [lockUrl("poetry.lock")]: { status: 200 },
          [lockUrl("Pipfile.lock")]: { status: 404 },
          [lockUrl("pdm.lock")]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.lock_file_present).toBe(true);
      expect(result.warnings.some((w) => w.includes("No lock file"))).toBe(false);
    });

    it("reports lock_file_present: false with a warning when no lock file exists", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [pyprojectUrl()]: { status: 200, body: `[project]\ndependencies = []\n` },
          [requirementsUrl()]: { status: 404 },
          ...noLockFiles(),
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.lock_file_present).toBe(false);
      expect(result.warnings.some((w) => w.includes("No lock file detected"))).toBe(true);
    });

    it("skips lock-file checks entirely when neither manifest is found", async () => {
      const fetchMock = mockFetch({
        [pyprojectUrl()]: { status: 404 },
        [requirementsUrl()]: { status: 404 },
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await ingestor.parseDependencies(BASE);

      expect(result.manifest_resolved).toBe(false);
      expect(fetchMock).not.toHaveBeenCalledWith(lockUrl("poetry.lock"), expect.anything());
    });
  });

  describe("parseDependencies — network errors", () => {
    it("throws a descriptive error when fetch rejects (network failure)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      await expect(ingestor.parseDependencies(BASE)).rejects.toThrow(/Network error fetching/);
    });

    it("throws a descriptive error on an unexpected non-404 HTTP status", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [pyprojectUrl()]: { status: 500 },
          [requirementsUrl()]: { status: 404 },
        }),
      );

      await expect(ingestor.parseDependencies(BASE)).rejects.toThrow(/Unexpected HTTP 500/);
    });
  });
});
