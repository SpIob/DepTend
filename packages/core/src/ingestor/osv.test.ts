/**
 * OsvFetcher unit tests
 *
 * All OSV API calls are mocked via vi.stubGlobal — no network access.
 * Tests cover: happy path, deduplication, severity mapping, version
 * extraction, edge cases, and error handling.
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

/** Minimal OSV vulnerability shape */
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

function mockOsvResponse(results: { vulns?: unknown[] }[]): () => Response {
  return vi.fn(
    (): Response =>
      new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
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

    it("maps a single advisory correctly", async () => {
      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [makeVuln()] }]));

      const result = await fetcher.fetchAdvisories([dep("lodash")]);

      expect(result.advisories.size).toBe(1);
      const advisory = result.advisories.get("GHSA-xxxx-yyyy-zzzz");

      expect(advisory).toBeDefined();
      expect(advisory?.osvId).toBe("GHSA-xxxx-yyyy-zzzz");
      expect(advisory?.source).toBe("ghsa");
      expect(advisory?.ecosystem).toBe("npm");
      expect(advisory?.packageName).toBe("lodash");
      expect(advisory?.severity).toBe("high");
      expect(advisory?.cvssScore).toBe("7.5");
      expect(advisory?.summary).toBe("Test vulnerability");
      expect(advisory?.details).toBe("Detailed description here.");
      expect(advisory?.fixedVersion).toBe("4.17.21");
      expect(advisory?.publishedAt).toEqual(new Date("2024-01-10T00:00:00Z"));
      expect(advisory?.modifiedAt).toEqual(new Date("2024-01-15T00:00:00Z"));
    });

    it("sets source to 'osv' for non-GHSA IDs", async () => {
      const vuln = makeVuln({ id: "OSV-2024-001" });
      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [vuln] }]));

      const result = await fetcher.fetchAdvisories([dep("lodash")]);
      expect(result.advisories.get("OSV-2024-001")?.source).toBe("osv");
    });

    it("populates packageAdvisoryMap correctly", async () => {
      const vuln1 = makeVuln({ id: "GHSA-aaaa-bbbb-cccc" });
      const vuln2 = makeVuln({ id: "GHSA-dddd-eeee-ffff" });

      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [vuln1, vuln2] }, { vulns: [] }]));

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
          capturedBody.push(JSON.parse(init?.body as string) as unknown);
          return new Response(JSON.stringify({ results: [{ vulns: [] }] }), { status: 200 });
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

    it("deduplicates advisories that affect multiple packages in the same batch", async () => {
      // Same advisory ID returned for two different packages
      const sharedVuln = makeVuln({ id: "GHSA-shared-0000-0000" });

      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [sharedVuln] }, { vulns: [sharedVuln] }]));

      const result = await fetcher.fetchAdvisories([dep("pkg-a"), dep("pkg-b")]);

      // Stored only once
      expect(result.advisories.size).toBe(1);
      // But both packages reference it
      expect(result.packageAdvisoryMap.get("pkg-a")).toContain("GHSA-shared-0000-0000");
      expect(result.packageAdvisoryMap.get("pkg-b")).toContain("GHSA-shared-0000-0000");
    });

    it("returns no advisories for a package with no known vulnerabilities", async () => {
      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [] }]));

      const result = await fetcher.fetchAdvisories([dep("safe-package")]);

      expect(result.advisories.size).toBe(0);
      expect(result.packageAdvisoryMap.size).toBe(0);
      expect(result.warnings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("fetchAdvisories — severity extraction", () => {
    it("uses CVSS v3 score for severity", async () => {
      const vuln = makeVuln({ severity: [{ type: "CVSS_V3", score: "9.8" }] });
      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [vuln] }]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.severity).toBe("critical");
    });

    it("falls back to CVSS v2 when v3 is absent", async () => {
      const vuln = makeVuln({ severity: [{ type: "CVSS_V2", score: "5.0" }] });
      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [vuln] }]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.severity).toBe("medium");
    });

    it("falls back to database_specific.severity string", async () => {
      const vuln = makeVuln({
        severity: [],
        database_specific: { severity: "MODERATE" },
      });
      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [vuln] }]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.severity).toBe("medium");
    });

    it("records 'unknown' severity and warns when no severity data present", async () => {
      const vuln = makeVuln({ severity: undefined, database_specific: undefined });
      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [vuln] }]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.severity).toBe("unknown");
      expect(result.warnings.some((w) => w.includes("unknown"))).toBe(true);
    });

    it("records null cvssScore when no numeric score is parseable", async () => {
      const vuln = makeVuln({ severity: [] });
      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [vuln] }]));

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
      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [vuln] }]));

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
      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [vuln] }]));

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
      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [vuln] }]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      const advisory = result.advisories.get("GHSA-xxxx-yyyy-zzzz");
      const ranges = advisory?.affectedVersions as { type: string }[];
      expect(ranges.every((r) => r.type === "SEMVER")).toBe(true);
      expect(ranges).toHaveLength(1);
    });

    it("stores empty affectedVersions array when no ranges exist", async () => {
      const vuln = makeVuln({ affected: [] });
      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [vuln] }]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.affectedVersions).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("fetchAdvisories — data quality edge cases", () => {
    it("uses advisory ID as summary fallback when summary is absent", async () => {
      const vuln = makeVuln({ summary: undefined });
      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [vuln] }]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.summary).toBe(
        "Advisory GHSA-xxxx-yyyy-zzzz",
      );
    });

    it("skips vulns with no id and records a warning", async () => {
      const vuln = makeVuln({ id: undefined });
      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [vuln] }]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.size).toBe(0);
      expect(result.warnings.some((w) => w.includes("no id"))).toBe(true);
    });

    it("records rawData verbatim on the advisory", async () => {
      const vuln = makeVuln();
      vi.stubGlobal("fetch", mockOsvResponse([{ vulns: [vuln] }]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      const advisory = result.advisories.get("GHSA-xxxx-yyyy-zzzz");
      expect((advisory?.rawData as Record<string, unknown>).id).toBe("GHSA-xxxx-yyyy-zzzz");
    });

    it("warns when batch exceeds 1000 packages and truncates to limit", async () => {
      const manyDeps = Array.from({ length: 1001 }, (_, i) => dep(`pkg-${String(i)}`));
      // Return 1000 empty results (matching the truncated query count)
      const results = Array.from({ length: 1000 }, () => ({ vulns: [] }));
      vi.stubGlobal("fetch", mockOsvResponse(results));

      const result = await fetcher.fetchAdvisories(manyDeps);
      expect(result.warnings.some((w) => w.includes("1001"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("fetchAdvisories — network and API errors", () => {
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
