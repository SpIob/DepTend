/**
 * GoIngestor unit tests
 *
 * Uses Vitest's built-in fetch mocking via vi.stubGlobal so no network
 * calls are made — same approach as npm.test.ts/pypi.test.ts. Dependency-
 * parsing edge cases (require blocks, indirect exclusion, module path
 * validation) are already thoroughly covered directly in
 * go-parse.test.ts — these tests focus on what's actually new here:
 * fetching go.mod, detecting go.sum remotely, and error handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoIngestor } from "./go.js";
import { BASE, lockUrl, mockFetch } from "./test-helpers.js";

function goModUrl(base = BASE): string {
  return `${base}/go.mod`;
}

const SIMPLE_GO_MOD = `module example.com/x\n\ngo 1.22\n\nrequire (\n\tgithub.com/foo/bar v1.0.0\n)\n`;

describe("GoIngestor", () => {
  let ingestor: GoIngestor;

  beforeEach(() => {
    // Transport backoff/deadline disabled — failure-path tests below stub a
    // rejecting fetch and must not sleep through the real 30 s policy.
    ingestor = new GoIngestor({ retryDelayMs: 0, timeoutMs: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has the correct ecosystem property", () => {
    expect(ingestor.ecosystem).toBe("go");
  });

  describe("parseDependencies — happy path", () => {
    it("fetches and parses go.mod", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [goModUrl()]: { status: 200, body: SIMPLE_GO_MOD },
          [lockUrl("go.sum")]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.ecosystem).toBe("go");
      expect(result.manifest_resolved).toBe(true);
      expect(result.dependencies).toEqual([
        { package_name: "github.com/foo/bar", version_spec: "v1.0.0", dep_type: "production" },
      ]);
    });

    it("tolerates a trailing slash in the base URL", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [goModUrl()]: { status: 200, body: SIMPLE_GO_MOD },
          [lockUrl("go.sum")]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(`${BASE}/`);
      expect(result.dependencies).toHaveLength(1);
    });
  });

  describe("parseDependencies — lock file detection", () => {
    it("detects go.sum presence", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [goModUrl()]: { status: 200, body: SIMPLE_GO_MOD },
          [lockUrl("go.sum")]: { status: 200 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.lock_file_present).toBe(true);
      expect(result.warnings.some((w) => w.includes("No lock file"))).toBe(false);
    });

    it("reports lock_file_present: false with a warning when go.sum is absent", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [goModUrl()]: { status: 200, body: SIMPLE_GO_MOD },
          [lockUrl("go.sum")]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.lock_file_present).toBe(false);
      expect(result.warnings.some((w) => w.includes("No lock file detected"))).toBe(true);
    });

    it("skips the lock-file check entirely when go.mod is not found", async () => {
      const fetchMock = mockFetch({
        [goModUrl()]: { status: 404 },
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await ingestor.parseDependencies(BASE);

      expect(result.manifest_resolved).toBe(false);
      expect(fetchMock).not.toHaveBeenCalledWith(lockUrl("go.sum"), expect.anything());
    });
  });

  describe("parseDependencies — missing / malformed go.mod", () => {
    it("returns empty result with warning when go.mod is 404", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [goModUrl()]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.dependencies).toHaveLength(0);
      expect(result.lock_file_present).toBe(false);
      expect(result.manifest_resolved).toBe(false);
      expect(result.warnings.some((w) => w.includes("No go.mod found"))).toBe(true);
    });

    it("returns unresolved when go.mod content has no module directive", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [goModUrl()]: { status: 200, body: "not actually a go.mod\n" },
          [lockUrl("go.sum")]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.manifest_resolved).toBe(false);
      expect(result.warnings.some((w) => w.includes('No "module" directive'))).toBe(true);
    });
  });

  describe("parseDependencies — network errors", () => {
    it("throws a descriptive error when fetch rejects (network failure)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      await expect(ingestor.parseDependencies(BASE)).rejects.toThrow(
        /Network error fetching go\.mod/,
      );
    });

    it("throws on unexpected HTTP error fetching go.mod", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [goModUrl()]: { status: 500 },
        }),
      );

      await expect(ingestor.parseDependencies(BASE)).rejects.toThrow(/Unexpected HTTP 500/);
    });
  });
});
