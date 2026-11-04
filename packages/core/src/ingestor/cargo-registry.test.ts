/**
 * CratesRegistryFetcher unit tests
 *
 * All network calls are mocked via vi.stubGlobal. Mirrors
 * go-registry.test.ts's structure — happy path, dedup, failure modes —
 * plus the crates.io-specific behaviors: the required User-Agent header,
 * the repository/repository_url/homepage source-repo fallback chain, and
 * the deliberate isDeprecated/deprecationNote: always false/null decision
 * (ADR 0063).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRATES_CONCURRENCY, CratesRegistryFetcher } from "./cargo-registry.js";
import type { ParsedDependency } from "./interface.js";

function dep(
  package_name: string,
  dep_type: ParsedDependency["dep_type"] = "production",
): ParsedDependency {
  return { package_name, version_spec: "1.0", dep_type };
}

/** Build a minimal crates.io /api/v1/crates/<name> response body */
function cratesBody(
  version: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    crate: { id: "serde", name: "serde", max_version: version, ...extras },
  };
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

const BASE = "https://crates.io/api/v1/crates";
function url(crateName: string): string {
  return `${BASE}/${crateName}`;
}

describe("CratesRegistryFetcher", () => {
  let fetcher: CratesRegistryFetcher;

  beforeEach(() => {
    fetcher = new CratesRegistryFetcher();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to concurrency 1 (the ADR 0063 rate-policy mitigation)", () => {
    expect(CRATES_CONCURRENCY).toBe(1);
  });

  it("fetches max_version for each unique crate", async () => {
    const fetchMock = mockFetch({
      [url("serde")]: { status: 200, body: cratesBody("1.0.219") },
      [url("tokio")]: { status: 200, body: cratesBody("1.41.0") },
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetcher.fetchMetadata([
      dep("serde"),
      dep("tokio"),
      dep("serde", "development"),
    ]);

    expect(result.warnings).toEqual([]);
    expect(result.metadata.get("serde")?.latestVersion).toBe("1.0.219");
    expect(result.metadata.get("tokio")?.latestVersion).toBe("1.41.0");
    // Deduplicated: 3 dep rows → 2 crates → 2 fetches.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the required User-Agent header on every request", async () => {
    let seenUserAgent: string | null = null;
    const fetchMock = vi.fn((_input: string | URL, init?: RequestInit): Response => {
      const headers = new Headers(init?.headers);
      seenUserAgent = headers.get("User-Agent");
      return new Response(JSON.stringify(cratesBody("1.0.219")), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetcher.fetchMetadata([dep("serde")]);

    expect(seenUserAgent).toBe("DepTend/0.1 (+https://deptend.vercel.app)");
  });

  it("resolves sourceRepo from crate.repository", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        [url("serde")]: {
          status: 200,
          body: cratesBody("1.0.219", { repository: "https://github.com/serde-rs/serde" }),
        },
      }),
    );

    const result = await fetcher.fetchMetadata([dep("serde")]);

    expect(result.metadata.get("serde")?.sourceRepo).toEqual({
      owner: "serde-rs",
      name: "serde",
    });
  });

  it("falls back to repository_url when repository is absent", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        [url("serde")]: {
          status: 200,
          body: cratesBody("1.0.219", { repository_url: "https://github.com/foo/bar" }),
        },
      }),
    );

    const result = await fetcher.fetchMetadata([dep("serde")]);

    expect(result.metadata.get("serde")?.sourceRepo).toEqual({ owner: "foo", name: "bar" });
  });

  it("returns null sourceRepo for a non-GitHub homepage (no fallback match)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        [url("serde")]: {
          status: 200,
          body: cratesBody("1.0.219", { homepage: "https://serde.rs" }),
        },
      }),
    );

    const result = await fetcher.fetchMetadata([dep("serde")]);

    expect(result.metadata.get("serde")?.sourceRepo).toBeNull();
  });

  it("always reports isDeprecated: false / deprecationNote: null (ADR 0063 Decision 4)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        [url("serde")]: { status: 200, body: cratesBody("1.0.219") },
      }),
    );

    const result = await fetcher.fetchMetadata([dep("serde")]);

    const meta = result.metadata.get("serde");
    expect(meta?.isDeprecated).toBe(false);
    expect(meta?.deprecationNote).toBeNull();
  });

  it("warns and returns null latestVersion when the crate object is missing", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        [url("serde")]: { status: 200, body: { keywords: [], versions: [] } },
      }),
    );

    const result = await fetcher.fetchMetadata([dep("serde")]);

    expect(result.metadata.get("serde")?.latestVersion).toBeNull();
    expect(result.warnings.some((w) => w.includes('missing a "crate" object'))).toBe(true);
  });

  it("warns and returns null latestVersion on a 404 (unpublished crate)", async () => {
    vi.stubGlobal("fetch", mockFetch({}));

    const result = await fetcher.fetchMetadata([dep("never-existed")]);

    expect(result.metadata.get("never-existed")?.latestVersion).toBeNull();
    expect(result.warnings.some((w) => w.includes("not found on crates.io (404)"))).toBe(true);
  });

  it("warns on a network error and keeps the pipeline alive (fail-soft)", async () => {
    // Transport backoff/deadline disabled — this test stubs a rejecting
    // fetch and must not sleep through the real 30 s retry policy.
    const failFast = new CratesRegistryFetcher(undefined, undefined, {
      retryDelayMs: 0,
      timeoutMs: 0,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("socket hang up"))),
    );

    const result = await failFast.fetchMetadata([dep("serde")]);

    expect(result.metadata.get("serde")?.latestVersion).toBeNull();
    expect(result.warnings.some((w) => w.includes("Network error"))).toBe(true);
  });

  it("warns on an unexpected HTTP status", async () => {
    // Transport disabled — fetch-retry retries 5xx with the real backoff.
    const failFast = new CratesRegistryFetcher(undefined, undefined, {
      retryDelayMs: 0,
      timeoutMs: 0,
    });
    vi.stubGlobal(
      "fetch",
      mockFetch({
        [url("serde")]: { status: 500 },
      }),
    );

    const result = await failFast.fetchMetadata([dep("serde")]);

    expect(result.metadata.get("serde")?.latestVersion).toBeNull();
    expect(result.warnings.some((w) => w.includes("Unexpected HTTP 500"))).toBe(true);
  });
});
