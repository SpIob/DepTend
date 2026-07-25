/**
 * PyPIRegistryFetcher unit tests
 *
 * All network calls are mocked via vi.stubGlobal. Mirrors registry.test.ts's
 * structure and coverage — happy path, deduplication, concurrency, all
 * failure modes — plus PyPI-specific cases: the nested "info" object shape,
 * and the deliberate isDeprecated/deprecationNote: always false/null
 * decision (ADR 0022) holding even when a response's "yanked" field is
 * true, which npm has no equivalent of.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PyPIRegistryFetcher } from "./pypi-registry.js";
import type { ParsedDependency } from "./interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dep(
  package_name: string,
  dep_type: ParsedDependency["dep_type"] = "production",
): ParsedDependency {
  return { package_name, version_spec: ">=1.0.0", dep_type };
}

/** Build a minimal PyPI JSON API response body */
function pypiJson(
  version: string,
  extraInfo: Record<string, unknown> = {},
): Record<string, unknown> {
  return { info: { version, name: "pkg", ...extraInfo } };
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

const BASE = "https://pypi.org/pypi";
function url(name: string): string {
  return `${BASE}/${encodeURIComponent(name)}/json`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PyPIRegistryFetcher", () => {
  let fetcher: PyPIRegistryFetcher;

  beforeEach(() => {
    // Use a single concurrency slot in tests to get deterministic ordering
    fetcher = new PyPIRegistryFetcher(BASE, 1);
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

    it("returns correct metadata for a package", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ [url("requests")]: { status: 200, body: pypiJson("2.31.0") } }),
      );

      const result = await fetcher.fetchMetadata([dep("requests")]);

      const meta = result.metadata.get("requests");
      expect(meta).toBeDefined();
      expect(meta?.latestVersion).toBe("2.31.0");
      expect(result.warnings).toHaveLength(0);
    });

    it("always reports isDeprecated: false and deprecationNote: null (ADR 0022 — no npm-equivalent field on PyPI)", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ [url("requests")]: { status: 200, body: pypiJson("2.31.0") } }),
      );

      const result = await fetcher.fetchMetadata([dep("requests")]);
      const meta = result.metadata.get("requests");

      expect(meta?.isDeprecated).toBe(false);
      expect(meta?.deprecationNote).toBeNull();
    });

    it("still reports isDeprecated: false even when the latest release is yanked", async () => {
      // "yanked" means one specific release was pulled, not "package
      // deprecated" — deliberately not treated as a deprecation signal.
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [url("some-pkg")]: {
            status: 200,
            body: pypiJson("1.0.0", { yanked: true, yanked_reason: "security issue" }),
          },
        }),
      );

      const result = await fetcher.fetchMetadata([dep("some-pkg")]);
      const meta = result.metadata.get("some-pkg");

      expect(meta?.latestVersion).toBe("1.0.0");
      expect(meta?.isDeprecated).toBe(false);
      expect(meta?.deprecationNote).toBeNull();
    });

    it("fetches multiple packages and returns all metadata", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [url("requests")]: { status: 200, body: pypiJson("2.31.0") },
          [url("click")]: { status: 200, body: pypiJson("8.1.7") },
          [url("flask")]: { status: 200, body: pypiJson("3.1.3") },
        }),
      );

      const result = await fetcher.fetchMetadata([dep("requests"), dep("click"), dep("flask")]);

      expect(result.metadata.size).toBe(3);
      expect(result.metadata.get("requests")?.latestVersion).toBe("2.31.0");
      expect(result.metadata.get("click")?.latestVersion).toBe("8.1.7");
      expect(result.metadata.get("flask")?.latestVersion).toBe("3.1.3");
    });
  });

  // -------------------------------------------------------------------------
  describe("fetchMetadata — deduplication", () => {
    it("makes only one request when the same package appears multiple times", async () => {
      const fetchSpy = vi.fn(
        (): Response => new Response(JSON.stringify(pypiJson("1.0.0")), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchSpy);

      await fetcher.fetchMetadata([
        { package_name: "requests", version_spec: ">=2.0", dep_type: "production" },
        { package_name: "requests", version_spec: ">=2.0", dep_type: "optional" },
      ]);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("returns a single metadata entry for a deduplicated package", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ [url("requests")]: { status: 200, body: pypiJson("2.31.0") } }),
      );

      const result = await fetcher.fetchMetadata([
        dep("requests", "production"),
        dep("requests", "optional"),
      ]);

      expect(result.metadata.size).toBe(1);
      expect(result.metadata.get("requests")?.latestVersion).toBe("2.31.0");
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
          [url("pkg")]: { status: 200, body: { info: { name: "pkg" } } }, // no version
        }),
      );

      const result = await fetcher.fetchMetadata([dep("pkg")]);

      expect(result.metadata.get("pkg")?.latestVersion).toBeNull();
      expect(result.warnings.some((w) => w.includes("no version field"))).toBe(true);
    });

    it("records a warning when the response is missing the info object entirely", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [url("pkg")]: { status: 200, body: { releases: {} } }, // no "info" key at all
        }),
      );

      const result = await fetcher.fetchMetadata([dep("pkg")]);

      expect(result.metadata.get("pkg")?.latestVersion).toBeNull();
      expect(result.warnings.some((w) => w.includes('missing an "info" object'))).toBe(true);
    });

    it("records a warning when info is explicitly null rather than absent", async () => {
      // typeof null === "object" in JS — this specifically exercises why
      // the info === null check can't be dropped just because it looks
      // redundant next to typeof info !== "object".
      vi.stubGlobal("fetch", mockFetch({ [url("pkg")]: { status: 200, body: { info: null } } }));

      const result = await fetcher.fetchMetadata([dep("pkg")]);

      expect(result.metadata.get("pkg")?.latestVersion).toBeNull();
      expect(result.warnings.some((w) => w.includes('missing an "info" object'))).toBe(true);
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
          [url("good-pkg")]: { status: 200, body: pypiJson("2.0.0") },
          [url("bad-pkg")]: { status: 503 },
        }),
      );

      const result = await fetcher.fetchMetadata([dep("good-pkg"), dep("bad-pkg")]);

      expect(result.metadata.get("good-pkg")?.latestVersion).toBe("2.0.0");
      expect(result.metadata.get("bad-pkg")?.latestVersion).toBeNull();
      expect(result.warnings).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("fetchMetadata — concurrency", () => {
    it("resolves correctly with concurrency > 1", async () => {
      const concurrentFetcher = new PyPIRegistryFetcher(BASE, 5);

      const packages = ["a", "b", "c", "d", "e"];
      const responses: UrlResponses = {};
      for (const name of packages) {
        responses[url(name)] = { status: 200, body: pypiJson(`1.0.${name}`) };
      }
      vi.stubGlobal("fetch", mockFetch(responses));

      const result = await concurrentFetcher.fetchMetadata(packages.map((n) => dep(n)));

      expect(result.metadata.size).toBe(5);
      for (const name of packages) {
        expect(result.metadata.get(name)?.latestVersion).toBe(`1.0.${name}`);
      }
    });

    it("respects the registry base URL injected via constructor", async () => {
      const customBase = "https://my-pypi-mirror.example.com";
      const customFetcher = new PyPIRegistryFetcher(customBase, 1);

      const capturedUrls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL): Response => {
          capturedUrls.push(input.toString());
          return new Response(JSON.stringify(pypiJson("1.0.0")), { status: 200 });
        }),
      );

      await customFetcher.fetchMetadata([dep("pkg")]);

      expect(capturedUrls[0]).toContain("my-pypi-mirror.example.com");
    });
  });
});
