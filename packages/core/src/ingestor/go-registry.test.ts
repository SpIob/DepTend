/**
 * GoRegistryFetcher / encodeGoModulePath unit tests
 *
 * All network calls are mocked via vi.stubGlobal. Mirrors registry.test.ts/
 * pypi-registry.test.ts's structure and coverage — happy path,
 * deduplication, concurrency, all failure modes — plus Go-specific cases:
 * the module-path case-encoding rule (no npm/PyPI equivalent), and the
 * deliberate isDeprecated/deprecationNote: always false/null decision
 * (ADR 0024).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeGoModulePath, GoRegistryFetcher } from "./go-registry.js";
import type { ParsedDependency } from "./interface.js";

// ---------------------------------------------------------------------------
// encodeGoModulePath — pure function, no mocking needed
// ---------------------------------------------------------------------------

describe("encodeGoModulePath", () => {
  it("leaves an all-lowercase path unchanged", () => {
    expect(encodeGoModulePath("github.com/foo/bar")).toBe("github.com/foo/bar");
  });

  it("case-encodes a single uppercase letter as ! + lowercase", () => {
    expect(encodeGoModulePath("Foo")).toBe("!foo");
  });

  it("case-encodes every uppercase letter in a real-world mixed-case module path", () => {
    // Documented protocol example (golang.org/x/mod/module's own EscapePath).
    expect(encodeGoModulePath("github.com/Azure/azure-sdk-for-go")).toBe(
      "github.com/!azure/azure-sdk-for-go",
    );
  });

  it("case-encodes a major-version-suffixed path without disturbing the /vN suffix", () => {
    expect(encodeGoModulePath("github.com/Masterminds/semver/v3")).toBe(
      "github.com/!masterminds/semver/v3",
    );
  });

  it("leaves digits, dots, hyphens, underscores, tildes, and slashes unchanged", () => {
    expect(encodeGoModulePath("example.com/a-b_c~d.e/f2")).toBe("example.com/a-b_c~d.e/f2");
  });

  it("handles a path with no uppercase letters at all as a no-op", () => {
    expect(encodeGoModulePath("go.uber.org/zap")).toBe("go.uber.org/zap");
  });

  it("handles consecutive uppercase letters, encoding each individually", () => {
    expect(encodeGoModulePath("example.com/ABC")).toBe("example.com/!a!b!c");
  });
});

// ---------------------------------------------------------------------------
// GoRegistryFetcher
// ---------------------------------------------------------------------------

function dep(
  package_name: string,
  dep_type: ParsedDependency["dep_type"] = "production",
): ParsedDependency {
  return { package_name, version_spec: "v1.0.0", dep_type };
}

/** Build a minimal Go module proxy @latest response body */
function goLatest(version: string): Record<string, unknown> {
  return { Version: version, Time: "2021-01-01T00:00:00Z" };
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

const BASE = "https://proxy.golang.org";
function url(modulePath: string): string {
  return `${BASE}/${encodeGoModulePath(modulePath)}/@latest`;
}

describe("GoRegistryFetcher", () => {
  let fetcher: GoRegistryFetcher;

  beforeEach(() => {
    // Single concurrency slot in tests for deterministic ordering, same
    // convention registry.test.ts/pypi-registry.test.ts already use.
    fetcher = new GoRegistryFetcher(BASE, 1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("fetchMetadata — happy path", () => {
    it("returns empty result for empty dependency list", async () => {
      const result = await fetcher.fetchMetadata([]);
      expect(result.metadata.size).toBe(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("returns correct metadata for a lowercase module path", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ [url("github.com/pkg/errors")]: { status: 200, body: goLatest("v0.9.1") } }),
      );

      const result = await fetcher.fetchMetadata([dep("github.com/pkg/errors")]);

      const meta = result.metadata.get("github.com/pkg/errors");
      expect(meta).toBeDefined();
      expect(meta?.latestVersion).toBe("v0.9.1");
      // Always false/null for Phase 7 — see module docstring.
      expect(meta?.isDeprecated).toBe(false);
      expect(meta?.deprecationNote).toBeNull();
    });

    it("case-encodes a mixed-case module path when building the request URL", async () => {
      const fetchMock = mockFetch({
        [url("github.com/Azure/azure-sdk-for-go")]: { status: 200, body: goLatest("v68.0.0") },
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetcher.fetchMetadata([dep("github.com/Azure/azure-sdk-for-go")]);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://proxy.golang.org/github.com/!azure/azure-sdk-for-go/@latest",
      );
      // Metadata is still keyed by the *original* (un-escaped) module path
      // — encoding is a request-construction detail, not an identity change.
      expect(result.metadata.get("github.com/Azure/azure-sdk-for-go")?.latestVersion).toBe(
        "v68.0.0",
      );
    });

    it("deduplicates repeated module paths across dep_types before fetching", async () => {
      const fetchMock = mockFetch({
        [url("github.com/foo/bar")]: { status: 200, body: goLatest("v2.0.0") },
      });
      vi.stubGlobal("fetch", fetchMock);

      await fetcher.fetchMetadata([
        dep("github.com/foo/bar", "production"),
        dep("github.com/foo/bar", "production"),
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("fetchMetadata — failure modes", () => {
    it("records a warning and null latestVersion on 404", async () => {
      vi.stubGlobal("fetch", mockFetch({ [url("github.com/missing/pkg")]: { status: 404 } }));

      const result = await fetcher.fetchMetadata([dep("github.com/missing/pkg")]);

      const meta = result.metadata.get("github.com/missing/pkg");
      expect(meta?.latestVersion).toBeNull();
      expect(result.warnings.some((w) => w.includes("not found in the Go module proxy"))).toBe(
        true,
      );
    });

    it("records a warning on an unexpected non-404 HTTP status", async () => {
      vi.stubGlobal("fetch", mockFetch({ [url("github.com/foo/bar")]: { status: 500 } }));

      const result = await fetcher.fetchMetadata([dep("github.com/foo/bar")]);

      expect(result.warnings.some((w) => w.includes("Unexpected HTTP 500"))).toBe(true);
    });

    it("records a warning when the response body isn't valid JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response("not json {{{", { status: 200 }))),
      );

      const result = await fetcher.fetchMetadata([dep("github.com/foo/bar")]);

      expect(result.warnings.some((w) => w.includes("Failed to parse"))).toBe(true);
    });

    it("records a warning when the response shape is unexpected (array)", async () => {
      vi.stubGlobal("fetch", mockFetch({ [url("github.com/foo/bar")]: { status: 200, body: [] } }));

      const result = await fetcher.fetchMetadata([dep("github.com/foo/bar")]);

      expect(result.warnings.some((w) => w.includes("unexpected response shape"))).toBe(true);
    });

    it("records a warning when Version is missing from the response", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [url("github.com/foo/bar")]: { status: 200, body: { Time: "2021-01-01T00:00:00Z" } },
        }),
      );

      const result = await fetcher.fetchMetadata([dep("github.com/foo/bar")]);

      const meta = result.metadata.get("github.com/foo/bar");
      expect(meta?.latestVersion).toBeNull();
      expect(result.warnings.some((w) => w.includes("no Version field"))).toBe(true);
    });

    it("records a warning on a network error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const result = await fetcher.fetchMetadata([dep("github.com/foo/bar")]);

      expect(result.warnings.some((w) => w.includes("Network error"))).toBe(true);
    });

    it("continues processing other modules after one fails", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [url("github.com/good/pkg")]: { status: 200, body: goLatest("v1.0.0") },
          [url("github.com/bad/pkg")]: { status: 404 },
        }),
      );

      const result = await fetcher.fetchMetadata([
        dep("github.com/good/pkg"),
        dep("github.com/bad/pkg"),
      ]);

      expect(result.metadata.get("github.com/good/pkg")?.latestVersion).toBe("v1.0.0");
      expect(result.metadata.get("github.com/bad/pkg")?.latestVersion).toBeNull();
    });
  });

  describe("fetchMetadata — concurrency and configuration", () => {
    it("resolves correctly with concurrency > 1", async () => {
      const concurrentFetcher = new GoRegistryFetcher(BASE, 5);

      const modules = ["a", "b", "c", "d", "e"].map((n) => `example.com/${n}`);
      const responses: UrlResponses = {};
      for (const m of modules) {
        responses[url(m)] = { status: 200, body: goLatest(`v1.0.0-${m}`) };
      }
      vi.stubGlobal("fetch", mockFetch(responses));

      const result = await concurrentFetcher.fetchMetadata(modules.map((m) => dep(m)));

      expect(result.metadata.size).toBe(5);
      for (const m of modules) {
        expect(result.metadata.get(m)?.latestVersion).toBe(`v1.0.0-${m}`);
      }
    });

    it("respects the registry base URL injected via constructor", async () => {
      const customBase = "https://my-proxy.example.com";
      const customFetcher = new GoRegistryFetcher(customBase, 1);

      const fetchMock = mockFetch({
        [`${customBase}/github.com/foo/bar/@latest`]: { status: 200, body: goLatest("v1.0.0") },
      });
      vi.stubGlobal("fetch", fetchMock);

      await customFetcher.fetchMetadata([dep("github.com/foo/bar")]);

      expect(fetchMock).toHaveBeenCalledWith(`${customBase}/github.com/foo/bar/@latest`);
    });

    it("strips a trailing slash from a custom registry base URL", async () => {
      const customFetcher = new GoRegistryFetcher("https://my-proxy.example.com/", 1);

      const fetchMock = mockFetch({
        "https://my-proxy.example.com/github.com/foo/bar/@latest": {
          status: 200,
          body: goLatest("v1.0.0"),
        },
      });
      vi.stubGlobal("fetch", fetchMock);

      await customFetcher.fetchMetadata([dep("github.com/foo/bar")]);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://my-proxy.example.com/github.com/foo/bar/@latest",
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("fetchMetadata — sourceRepo resolution (ADR 0029)", () => {
    it("resolves sourceRepo directly from a github.com module path", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ [url("github.com/gorilla/mux")]: { status: 200, body: goLatest("v1.8.1") } }),
      );

      const result = await fetcher.fetchMetadata([dep("github.com/gorilla/mux")]);

      expect(result.metadata.get("github.com/gorilla/mux")?.sourceRepo).toEqual({
        owner: "gorilla",
        name: "mux",
      });
    });

    it("drops a major-version suffix segment when resolving sourceRepo", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [url("github.com/owner/repo/v2")]: { status: 200, body: goLatest("v2.1.0") },
        }),
      );

      const result = await fetcher.fetchMetadata([dep("github.com/owner/repo/v2")]);

      expect(result.metadata.get("github.com/owner/repo/v2")?.sourceRepo).toEqual({
        owner: "owner",
        name: "repo",
      });
    });

    it("returns null sourceRepo for a non-GitHub module path (golang.org/x/...)", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ [url("golang.org/x/mod")]: { status: 200, body: goLatest("v0.17.0") } }),
      );

      const result = await fetcher.fetchMetadata([dep("golang.org/x/mod")]);

      expect(result.metadata.get("golang.org/x/mod")?.sourceRepo).toBeNull();
    });

    it("returns null sourceRepo for a gopkg.in module path", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ [url("gopkg.in/yaml.v3")]: { status: 200, body: goLatest("v3.0.1") } }),
      );

      const result = await fetcher.fetchMetadata([dep("gopkg.in/yaml.v3")]);

      expect(result.metadata.get("gopkg.in/yaml.v3")?.sourceRepo).toBeNull();
    });

    it("still resolves sourceRepo on a 404 — derived from the path, not the response", async () => {
      vi.stubGlobal("fetch", mockFetch({}));

      const result = await fetcher.fetchMetadata([dep("github.com/owner/repo")]);
      const meta = result.metadata.get("github.com/owner/repo");

      expect(meta?.latestVersion).toBeNull();
      expect(meta?.sourceRepo).toEqual({ owner: "owner", name: "repo" });
    });

    it("still resolves sourceRepo on a network failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const result = await fetcher.fetchMetadata([dep("github.com/owner/repo")]);

      expect(result.metadata.get("github.com/owner/repo")?.sourceRepo).toEqual({
        owner: "owner",
        name: "repo",
      });
    });
  });
});
