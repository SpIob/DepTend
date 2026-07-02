/**
 * NpmRegistryFetcher unit tests
 *
 * All network calls are mocked via vi.stubGlobal. Tests cover: happy path,
 * deprecation detection, deduplication, concurrency, and all failure modes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NpmRegistryFetcher } from "./registry.js";
import type { ParsedDependency } from "./interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dep(
  package_name: string,
  dep_type: ParsedDependency["dep_type"] = "production",
): ParsedDependency {
  return { package_name, version_spec: "^1.0.0", dep_type };
}

/** Build a minimal npm /latest response body */
function npmLatest(version: string, deprecated?: string): Record<string, unknown> {
  const body: Record<string, unknown> = { version, name: "pkg" };
  if (deprecated !== undefined) body.deprecated = deprecated;
  return body;
}

type UrlResponses = Record<string, { status: number; body?: unknown }>;

function mockFetch(responses: UrlResponses): (input: string | URL) => Response {
  return vi.fn((input: string | URL): Response => {
    const url = input.toString();
    const match = responses[url];
    if (!match) return new Response(null, { status: 404 });
    return new Response(match.body !== undefined ? JSON.stringify(match.body) : null, {
      status: match.status,
    });
  });
}

const BASE = "https://registry.npmjs.org";
function url(name: string): string {
  return `${BASE}/${encodeURIComponent(name)}/latest`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NpmRegistryFetcher", () => {
  let fetcher: NpmRegistryFetcher;

  beforeEach(() => {
    // Use a single concurrency slot in tests to get deterministic ordering
    fetcher = new NpmRegistryFetcher(BASE, 1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  describe("fetchMetadata — happy path", () => {
    it("returns empty result for empty dependency list", async () => {
      const result = await fetcher.fetchMetadata([]);
      expect(result.metadata.size).toBe(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("returns correct metadata for a non-deprecated package", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ [url("lodash")]: { status: 200, body: npmLatest("4.18.1") } }),
      );

      const result = await fetcher.fetchMetadata([dep("lodash")]);

      const meta = result.metadata.get("lodash");
      expect(meta).toBeDefined();
      expect(meta?.latestVersion).toBe("4.18.1");
      expect(meta?.isDeprecated).toBe(false);
      expect(meta?.deprecationNote).toBeNull();
      expect(result.warnings).toHaveLength(0);
    });

    it("detects a deprecated package and captures the message", async () => {
      const msg = "request has been deprecated, see https://github.com/request/request/issues/3142";
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [url("request")]: {
            status: 200,
            body: npmLatest("2.88.2", msg),
          },
        }),
      );

      const result = await fetcher.fetchMetadata([dep("request")]);

      const meta = result.metadata.get("request");
      expect(meta?.isDeprecated).toBe(true);
      expect(meta?.deprecationNote).toBe(msg);
      expect(meta?.latestVersion).toBe("2.88.2");
      expect(result.warnings).toHaveLength(0);
    });

    it("handles scoped package names correctly in the URL", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [url("@deptend/core")]: {
            status: 200,
            body: npmLatest("0.0.1"),
          },
        }),
      );

      const result = await fetcher.fetchMetadata([dep("@deptend/core")]);
      expect(result.metadata.get("@deptend/core")?.latestVersion).toBe("0.0.1");
    });

    it("fetches multiple packages and returns all metadata", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [url("react")]: { status: 200, body: npmLatest("18.3.0") },
          [url("express")]: { status: 200, body: npmLatest("4.19.2") },
          [url("lodash")]: { status: 200, body: npmLatest("4.18.1") },
        }),
      );

      const result = await fetcher.fetchMetadata([dep("react"), dep("express"), dep("lodash")]);

      expect(result.metadata.size).toBe(3);
      expect(result.metadata.get("react")?.latestVersion).toBe("18.3.0");
      expect(result.metadata.get("express")?.latestVersion).toBe("4.19.2");
      expect(result.metadata.get("lodash")?.latestVersion).toBe("4.18.1");
    });
  });

  // -------------------------------------------------------------------------
  describe("fetchMetadata — deduplication", () => {
    it("makes only one request when the same package appears multiple times", async () => {
      const fetchSpy = vi.fn(
        (): Response => new Response(JSON.stringify(npmLatest("1.0.0")), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchSpy);

      await fetcher.fetchMetadata([
        { package_name: "react", version_spec: "^18.0.0", dep_type: "production" },
        { package_name: "react", version_spec: "^18.0.0", dep_type: "development" },
        { package_name: "react", version_spec: "^18.0.0", dep_type: "peer" },
      ]);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("returns a single metadata entry for a deduplicated package", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ [url("react")]: { status: 200, body: npmLatest("18.3.0") } }),
      );

      const result = await fetcher.fetchMetadata([
        dep("react", "production"),
        dep("react", "development"),
      ]);

      expect(result.metadata.size).toBe(1);
      expect(result.metadata.get("react")?.latestVersion).toBe("18.3.0");
    });
  });

  // -------------------------------------------------------------------------
  describe("fetchMetadata — failure modes (non-fatal)", () => {
    it("records a warning and null metadata for a 404 package", async () => {
      vi.stubGlobal("fetch", mockFetch({ [url("nonexistent-pkg-xyz")]: { status: 404 } }));

      const result = await fetcher.fetchMetadata([dep("nonexistent-pkg-xyz")]);

      const meta = result.metadata.get("nonexistent-pkg-xyz");
      expect(meta?.latestVersion).toBeNull();
      expect(meta?.isDeprecated).toBe(false);
      expect(result.warnings.some((w) => w.includes("not found"))).toBe(true);
    });

    it("records a warning on unexpected HTTP status (e.g. 503)", async () => {
      vi.stubGlobal("fetch", mockFetch({ [url("pkg")]: { status: 503 } }));

      const result = await fetcher.fetchMetadata([dep("pkg")]);

      expect(result.metadata.get("pkg")?.latestVersion).toBeNull();
      expect(result.warnings.some((w) => w.includes("503"))).toBe(true);
    });

    it("records a warning on network error and continues", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const result = await fetcher.fetchMetadata([dep("pkg")]);

      expect(result.metadata.get("pkg")?.latestVersion).toBeNull();
      expect(result.warnings.some((w) => w.includes("Network error"))).toBe(true);
    });

    it("records a warning when response has no version field", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [url("pkg")]: { status: 200, body: { name: "pkg" } }, // no version
        }),
      );

      const result = await fetcher.fetchMetadata([dep("pkg")]);

      expect(result.metadata.get("pkg")?.latestVersion).toBeNull();
      expect(result.warnings.some((w) => w.includes("no version field"))).toBe(true);
    });

    it("records a warning when response body is not valid JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((): Response => new Response("not json", { status: 200 })),
      );

      const result = await fetcher.fetchMetadata([dep("pkg")]);

      expect(result.metadata.get("pkg")?.latestVersion).toBeNull();
      expect(result.warnings.some((w) => w.includes("Failed to parse"))).toBe(true);
    });

    it("records a warning for an unexpected response shape (array body)", async () => {
      vi.stubGlobal("fetch", mockFetch({ [url("pkg")]: { status: 200, body: [] } }));

      const result = await fetcher.fetchMetadata([dep("pkg")]);

      expect(result.metadata.get("pkg")?.latestVersion).toBeNull();
      expect(result.warnings.some((w) => w.includes("unexpected response shape"))).toBe(true);
    });

    it("continues processing remaining packages after a single failure", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [url("good-pkg")]: { status: 200, body: npmLatest("2.0.0") },
          [url("bad-pkg")]: { status: 503 },
        }),
      );

      const result = await fetcher.fetchMetadata([dep("good-pkg"), dep("bad-pkg")]);

      expect(result.metadata.get("good-pkg")?.latestVersion).toBe("2.0.0");
      expect(result.metadata.get("bad-pkg")?.latestVersion).toBeNull();
      expect(result.warnings).toHaveLength(1);
    });

    it("ignores a deprecated field that is an empty string", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [url("pkg")]: { status: 200, body: npmLatest("1.0.0", "") },
        }),
      );

      const result = await fetcher.fetchMetadata([dep("pkg")]);
      const meta = result.metadata.get("pkg");

      // Empty string deprecated field should not be treated as deprecated
      expect(meta?.isDeprecated).toBe(false);
      expect(meta?.deprecationNote).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("fetchMetadata — concurrency", () => {
    it("resolves correctly with concurrency > 1", async () => {
      // Use a fetcher with higher concurrency for this test
      const concurrentFetcher = new NpmRegistryFetcher(BASE, 5);

      const packages = ["a", "b", "c", "d", "e"];
      const responses: UrlResponses = {};
      for (const name of packages) {
        responses[url(name)] = { status: 200, body: npmLatest(`1.0.${name}`) };
      }
      vi.stubGlobal("fetch", mockFetch(responses));

      const result = await concurrentFetcher.fetchMetadata(packages.map((n) => dep(n)));

      expect(result.metadata.size).toBe(5);
      for (const name of packages) {
        expect(result.metadata.get(name)?.latestVersion).toBe(`1.0.${name}`);
      }
    });

    it("respects the registry base URL injected via constructor", async () => {
      const customBase = "https://my-registry.example.com";
      const customFetcher = new NpmRegistryFetcher(customBase, 1);

      const capturedUrls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL): Response => {
          capturedUrls.push(input.toString());
          return new Response(JSON.stringify(npmLatest("1.0.0")), { status: 200 });
        }),
      );

      await customFetcher.fetchMetadata([dep("pkg")]);

      expect(capturedUrls[0]).toContain("my-registry.example.com");
    });
  });
});
