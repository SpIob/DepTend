/**
 * OsvFetcher unit tests
 *
 * All OSV API calls are mocked via vi.stubGlobal — no network access.
 *
 * Mocking mirrors OSV's real, documented two-endpoint contract (ADR 0010):
 *   - POST .../querybatch returns only {id, modified} per result — never
 *     severity/affected/summary/details. mockOsvApi's batchResults param
 *     reflects this; it only ever takes {id, modified}.
 *   - GET  .../vulns/{id} returns the full record. mockOsvApi's detailsById
 *     param supplies these, keyed by advisory id.
 *   - mockOsvApiForVulns is a convenience wrapper for the common case of "N
 *     packages, each with a known set of full vulnerability records" — it
 *     derives both the minimal batch entries and the detail lookup from a
 *     single list of full records, so most tests just supply full vulns.
 *
 * Tests cover: happy path, deduplication, severity mapping, version
 * extraction, edge cases, batch-level error handling, and detail-fetch
 * error handling (a single failed detail fetch must not fail the run).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OsvFetcher, cvssScoreToSeverity, mapStringSeverity } from "./osv.js";
import type { ParsedDependency } from "../ingestor/interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dep(package_name: string): ParsedDependency {
  return { package_name, version_spec: "^1.0.0", dep_type: "production" };
}

/** Full OSV vulnerability record — what GET /v1/vulns/{id} returns. */
function makeVuln(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "GHSA-xxxx-yyyy-zzzz",
    modified: "2024-01-15T00:00:00Z",
    published: "2024-01-10T00:00:00Z",
    summary: "Test vulnerability",
    details: "Detailed description here.",
    severity: [{ type: "CVSS_V3", score: "7.5" }],
    affected: [
      {
        package: { name: "lodash", ecosystem: "npm" },
        ranges: [
          {
            type: "SEMVER",
            events: [{ introduced: "0" }, { fixed: "4.17.21" }],
          },
        ],
      },
    ],
    ...overrides,
  };
}

interface MinimalVuln {
  id: string;
  modified?: string;
}

/**
 * Mocks both OSV endpoints in one fetch stub:
 *   - POST .../querybatch -> { results: batchResults } (minimal entries only)
 *   - GET  .../vulns/{id} -> detailsById[id], or a 404 if not present
 */
function mockOsvApi(
  batchResults: { vulns?: MinimalVuln[] }[],
  detailsById: Record<string, Record<string, unknown>> = {},
): ReturnType<typeof vi.fn> {
  return vi.fn((url: string | URL, init?: RequestInit): Response => {
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ results: batchResults }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET .../vulns/{id}
    const id = url.toString().split("/").pop() ?? "";
    const detail = detailsById[id];
    if (detail === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(detail), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

/**
 * Convenience wrapper for the common case: each package's results is a list
 * of FULL vulnerability records. Derives the minimal batch entries and the
 * detail-endpoint lookup map from them automatically.
 */
function mockOsvApiForVulns(
  perPackageFullVulns: Record<string, unknown>[][],
): ReturnType<typeof vi.fn> {
  const detailsById: Record<string, Record<string, unknown>> = {};

  const batchResults = perPackageFullVulns.map((vulns) => ({
    vulns: vulns.map((v): MinimalVuln => {
      const id = v.id as string;
      detailsById[id] = v;
      const modified = v.modified as string | undefined;
      return modified !== undefined ? { id, modified } : { id };
    }),
  }));

  return mockOsvApi(batchResults, detailsById);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OsvFetcher", () => {
  let fetcher: OsvFetcher;

  beforeEach(() => {
    fetcher = new OsvFetcher();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  describe("fetchAdvisories — happy path", () => {
    it("returns empty result for empty dependency list", async () => {
      const result = await fetcher.fetchAdvisories([]);
      expect(result.advisories.size).toBe(0);
      expect(result.packageAdvisoryMap.size).toBe(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("maps a single advisory correctly, using the detail endpoint's full record", async () => {
      vi.stubGlobal("fetch", mockOsvApiForVulns([[makeVuln()]]));

      const result = await fetcher.fetchAdvisories([dep("lodash")]);

      expect(result.advisories.size).toBe(1);
      const advisory = result.advisories.get("GHSA-xxxx-yyyy-zzzz");

      expect(advisory).toBeDefined();
      expect(advisory?.osvId).toBe("GHSA-xxxx-yyyy-zzzz");
      expect(advisory?.source).toBe("ghsa");
      expect(advisory?.ecosystem).toBe("npm");
      expect(advisory?.packageName).toBe("lodash");
      expect(advisory?.severity).toBe("high");
      expect(advisory?.cvssScore).toBe(7.5);
      expect(advisory?.summary).toBe("Test vulnerability");
      expect(advisory?.details).toBe("Detailed description here.");
      expect(advisory?.fixedVersion).toBe("4.17.21");
      expect(advisory?.publishedAt).toEqual(new Date("2024-01-10T00:00:00Z"));
      expect(advisory?.modifiedAt).toEqual(new Date("2024-01-15T00:00:00Z"));
    });

    it("sets source to 'osv' for non-GHSA IDs", async () => {
      const vuln = makeVuln({ id: "OSV-2024-001" });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("lodash")]);
      expect(result.advisories.get("OSV-2024-001")?.source).toBe("osv");
    });

    it("populates packageAdvisoryMap correctly", async () => {
      const vuln1 = makeVuln({ id: "GHSA-aaaa-bbbb-cccc" });
      const vuln2 = makeVuln({ id: "GHSA-dddd-eeee-ffff" });

      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln1, vuln2], []]));

      const result = await fetcher.fetchAdvisories([dep("lodash"), dep("express")]);

      expect(result.packageAdvisoryMap.get("lodash")).toEqual([
        "GHSA-aaaa-bbbb-cccc",
        "GHSA-dddd-eeee-ffff",
      ]);
      expect(result.packageAdvisoryMap.has("express")).toBe(false);
    });

    it("deduplicates packages before sending the batch request", async () => {
      const capturedBody: unknown[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: unknown, init?: RequestInit): Response => {
          if (init?.method === "POST") {
            capturedBody.push(JSON.parse(init.body as string) as unknown);
            return new Response(JSON.stringify({ results: [{ vulns: [] }] }), { status: 200 });
          }
          return new Response("not found", { status: 404 });
        }),
      );

      // Same package as both production and dev dep
      await fetcher.fetchAdvisories([
        { package_name: "react", version_spec: "^18.0.0", dep_type: "production" },
        { package_name: "react", version_spec: "^18.0.0", dep_type: "development" },
      ]);

      const body = capturedBody[0] as { queries: unknown[] };
      // Only one query sent despite two dep entries
      expect(body.queries).toHaveLength(1);
    });

    it("deduplicates advisories that affect multiple packages, fetching details only once", async () => {
      const sharedVuln = makeVuln({ id: "GHSA-shared-0000-0000" });
      let detailFetchCount = 0;

      vi.stubGlobal(
        "fetch",
        vi.fn((url: string | URL, init?: RequestInit): Response => {
          if (init?.method === "POST") {
            return new Response(
              JSON.stringify({
                results: [
                  { vulns: [{ id: "GHSA-shared-0000-0000" }] },
                  { vulns: [{ id: "GHSA-shared-0000-0000" }] },
                ],
              }),
              { status: 200 },
            );
          }
          detailFetchCount++;
          return new Response(JSON.stringify(sharedVuln), { status: 200 });
        }),
      );

      const result = await fetcher.fetchAdvisories([dep("pkg-a"), dep("pkg-b")]);

      // Stored only once
      expect(result.advisories.size).toBe(1);
      // Fetched only once, despite affecting two packages
      expect(detailFetchCount).toBe(1);
      // But both packages reference it
      expect(result.packageAdvisoryMap.get("pkg-a")).toContain("GHSA-shared-0000-0000");
      expect(result.packageAdvisoryMap.get("pkg-b")).toContain("GHSA-shared-0000-0000");
    });

    it("returns no advisories for a package with no known vulnerabilities", async () => {
      vi.stubGlobal("fetch", mockOsvApiForVulns([[]]));

      const result = await fetcher.fetchAdvisories([dep("safe-package")]);

      expect(result.advisories.size).toBe(0);
      expect(result.packageAdvisoryMap.size).toBe(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("attributes packageName to the first package an advisory was encountered under", async () => {
      const sharedVuln = makeVuln({ id: "GHSA-shared-1111-1111" });
      vi.stubGlobal(
        "fetch",
        mockOsvApi(
          [
            { vulns: [{ id: "GHSA-shared-1111-1111" }] },
            { vulns: [{ id: "GHSA-shared-1111-1111" }] },
          ],
          { "GHSA-shared-1111-1111": sharedVuln },
        ),
      );

      const result = await fetcher.fetchAdvisories([dep("first-pkg"), dep("second-pkg")]);
      expect(result.advisories.get("GHSA-shared-1111-1111")?.packageName).toBe("first-pkg");
    });
  });

  // -------------------------------------------------------------------------
  describe("fetchAdvisories — severity extraction", () => {
    it("uses CVSS v3 score for severity", async () => {
      const vuln = makeVuln({ severity: [{ type: "CVSS_V3", score: "9.8" }] });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.severity).toBe("critical");
    });

    it("falls back to CVSS v2 when v3 is absent", async () => {
      const vuln = makeVuln({ severity: [{ type: "CVSS_V2", score: "5.0" }] });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.severity).toBe("medium");
    });

    it("falls back to database_specific.severity string", async () => {
      const vuln = makeVuln({
        severity: [],
        database_specific: { severity: "MODERATE" },
      });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.severity).toBe("medium");
    });

    it("records 'unknown' severity and warns when no severity data present", async () => {
      const vuln = makeVuln({ severity: undefined, database_specific: undefined });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.severity).toBe("unknown");
      expect(result.warnings.some((w) => w.includes("unknown"))).toBe(true);
    });

    it("records null cvssScore when no numeric score is parseable", async () => {
      const vuln = makeVuln({ severity: [] });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.cvssScore).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("fetchAdvisories — version range extraction", () => {
    it("extracts fixed version from SEMVER range", async () => {
      const vuln = makeVuln({
        affected: [
          {
            ranges: [
              {
                type: "SEMVER",
                events: [{ introduced: "0" }, { fixed: "2.0.0" }],
              },
            ],
          },
        ],
      });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.fixedVersion).toBe("2.0.0");
    });

    it("sets fixedVersion to null when no fix exists", async () => {
      const vuln = makeVuln({
        affected: [
          {
            ranges: [
              {
                type: "SEMVER",
                events: [{ introduced: "0" }],
              },
            ],
          },
        ],
      });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.fixedVersion).toBeNull();
    });

    it("ignores GIT and ECOSYSTEM range types, stores only SEMVER", async () => {
      const vuln = makeVuln({
        affected: [
          {
            ranges: [
              { type: "GIT", events: [{ introduced: "abc123" }] },
              { type: "ECOSYSTEM", events: [{ introduced: "1.0.0" }] },
              { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "3.0.0" }] },
            ],
          },
        ],
      });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      const advisory = result.advisories.get("GHSA-xxxx-yyyy-zzzz");
      const ranges = advisory?.affectedVersions as { type: string }[];
      expect(ranges.every((r) => r.type === "SEMVER")).toBe(true);
      expect(ranges).toHaveLength(1);
    });

    it("stores empty affectedVersions array when no ranges exist", async () => {
      const vuln = makeVuln({ affected: [] });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.affectedVersions).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("fetchAdvisories — data quality edge cases", () => {
    it("uses advisory ID as summary fallback when summary is absent", async () => {
      const vuln = makeVuln({ summary: undefined });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.summary).toBe(
        "Advisory GHSA-xxxx-yyyy-zzzz",
      );
    });

    it("skips vulns with no id (checked against the batch response, before any detail fetch)", async () => {
      vi.stubGlobal(
        "fetch",
        mockOsvApi([{ vulns: [{ modified: "2024-01-15T00:00:00Z" } as MinimalVuln] }]),
      );

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.size).toBe(0);
      expect(result.warnings.some((w) => w.includes("no id"))).toBe(true);
    });

    it("records the full detail response verbatim as rawData, not the minimal batch entry", async () => {
      const vuln = makeVuln();
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      const advisory = result.advisories.get("GHSA-xxxx-yyyy-zzzz");
      const rawData = advisory?.rawData as Record<string, unknown>;
      expect(rawData.id).toBe("GHSA-xxxx-yyyy-zzzz");
      // Only present on the full record, never on the minimal batch entry —
      // proves rawData came from the detail fetch, not the batch response.
      expect(rawData.summary).toBe("Test vulnerability");
    });

    it("warns when batch exceeds 1000 packages and truncates to limit", async () => {
      const manyDeps = Array.from({ length: 1001 }, (_, i) => dep(`pkg-${String(i)}`));
      const results = Array.from({ length: 1000 }, () => ({ vulns: [] }));
      vi.stubGlobal("fetch", mockOsvApi(results));

      const result = await fetcher.fetchAdvisories(manyDeps);
      expect(result.warnings.some((w) => w.includes("1001"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("fetchAdvisories — batch query network and API errors", () => {
    it("throws a descriptive error on network failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      await expect(fetcher.fetchAdvisories([dep("pkg")])).rejects.toThrow(
        /Network error querying OSV/,
      );
    });

    it("throws on non-200 HTTP response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((): Response => new Response("", { status: 429 })),
      );

      await expect(fetcher.fetchAdvisories([dep("pkg")])).rejects.toThrow(/HTTP 429/);
    });

    it("throws when response body is not valid JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((): Response => new Response("not json", { status: 200 })),
      );

      await expect(fetcher.fetchAdvisories([dep("pkg")])).rejects.toThrow(/Failed to parse OSV/);
    });

    it("throws when response is missing the results array", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((): Response => new Response(JSON.stringify({ unexpected: true }), { status: 200 })),
      );

      await expect(fetcher.fetchAdvisories([dep("pkg")])).rejects.toThrow(
        /missing expected 'results'/,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("fetchAdvisories — detail fetch failures (ADR 0010)", () => {
    it("warns and drops just the one advisory when its detail fetch 404s, without failing the run", async () => {
      const goodVuln = makeVuln({ id: "GHSA-good-0000-0000" });
      vi.stubGlobal(
        "fetch",
        mockOsvApi(
          [{ vulns: [{ id: "GHSA-good-0000-0000" }, { id: "GHSA-missing-0000-0000" }] }],
          { "GHSA-good-0000-0000": goodVuln }, // no entry for the "missing" id -> mock 404s it
        ),
      );

      const result = await fetcher.fetchAdvisories([dep("pkg")]);

      expect(result.advisories.size).toBe(1);
      expect(result.advisories.has("GHSA-good-0000-0000")).toBe(true);
      expect(result.advisories.has("GHSA-missing-0000-0000")).toBe(false);
      expect(result.warnings.some((w) => w.includes("GHSA-missing-0000-0000"))).toBe(true);
    });

    it("drops a failed advisory from packageAdvisoryMap too, not just the advisories map", async () => {
      vi.stubGlobal("fetch", mockOsvApi([{ vulns: [{ id: "GHSA-missing-1111-1111" }] }], {}));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.packageAdvisoryMap.has("pkg")).toBe(false);
    });

    it("keeps a package's other advisories when only one of several fails", async () => {
      const goodVuln = makeVuln({ id: "GHSA-good-2222-2222" });
      vi.stubGlobal(
        "fetch",
        mockOsvApi([{ vulns: [{ id: "GHSA-good-2222-2222" }, { id: "GHSA-missing-2222-2222" }] }], {
          "GHSA-good-2222-2222": goodVuln,
        }),
      );

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.packageAdvisoryMap.get("pkg")).toEqual(["GHSA-good-2222-2222"]);
    });

    it("handles a network error on the detail fetch the same way as a 404", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string | URL, init?: RequestInit): Response | Promise<Response> => {
          if (init?.method === "POST") {
            return new Response(
              JSON.stringify({ results: [{ vulns: [{ id: "GHSA-neterr-0000" }] }] }),
              {
                status: 200,
              },
            );
          }
          return Promise.reject(new Error("ECONNRESET"));
        }),
      );

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.size).toBe(0);
      expect(result.warnings.some((w) => w.includes("GHSA-neterr-0000"))).toBe(true);
    });

    it("processes more unique advisories than the default concurrency limit correctly", async () => {
      const manyVulns = Array.from({ length: 25 }, (_, i) =>
        makeVuln({ id: `GHSA-many-${String(i)}` }),
      );
      vi.stubGlobal("fetch", mockOsvApiForVulns([manyVulns]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.size).toBe(25);
      expect(result.packageAdvisoryMap.get("pkg")).toHaveLength(25);
    });
  });
});

// ---------------------------------------------------------------------------
// Pure utility function tests
// ---------------------------------------------------------------------------

describe("cvssScoreToSeverity", () => {
  it.each([
    [9.0, "critical"],
    [9.8, "critical"],
    [10.0, "critical"],
    [7.0, "high"],
    [8.9, "high"],
    [4.0, "medium"],
    [6.9, "medium"],
    [0.1, "low"],
    [3.9, "low"],
    [0.0, "unknown"],
  ])("score %f → %s", (score, expected) => {
    expect(cvssScoreToSeverity(score)).toBe(expected);
  });
});

describe("mapStringSeverity", () => {
  it.each([
    ["critical", "critical"],
    ["CRITICAL", "critical"],
    ["high", "high"],
    ["HIGH", "high"],
    ["moderate", "medium"],
    ["MODERATE", "medium"],
    ["medium", "medium"],
    ["low", "low"],
    ["LOW", "low"],
  ])('"%s" → "%s"', (input, expected) => {
    expect(mapStringSeverity(input)).toBe(expected);
  });

  it("returns null for unrecognised strings", () => {
    expect(mapStringSeverity("informational")).toBeNull();
    expect(mapStringSeverity("")).toBeNull();
    expect(mapStringSeverity("n/a")).toBeNull();
  });
});
