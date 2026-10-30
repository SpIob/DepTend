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
import { OsvFetcher } from "./osv.js";
import { cvssScoreToSeverity, cvssVectorToBaseScore, mapStringSeverity } from "./cvss.js";
import { EpssFetcher } from "./epss.js";
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
    // Zero retry backoff — the delay is production pacing, not logic under
    // test; only WHICH calls get retried is.
    // EPSS enrichment disabled here — these suites stub only the OSV
    // endpoints; epss.test.ts covers the enrichment stage against its own
    // stubbed EPSS API, and the wiring test below asserts OsvFetcher calls it.
    fetcher = new OsvFetcher(undefined, undefined, undefined, 0, undefined, false);
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

    it("computes cvssScore and severity from a v3 vector string when no bare score exists", async () => {
      // Real GitHub Advisory shape: many records carry only the vector —
      // before the vector parser, both cvssScore and the derived severity
      // under-read to null/"unknown" for exactly these.
      const vuln = makeVuln({
        severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
        database_specific: undefined,
      });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      const advisory = result.advisories.get("GHSA-xxxx-yyyy-zzzz");

      expect(advisory?.cvssScore).toBe(9.8);
      expect(advisory?.severity).toBe("critical");
    });

    it("computes cvssScore and severity from an unprefixed v2 vector string", async () => {
      const vuln = makeVuln({
        severity: [{ type: "CVSS_V2", score: "AV:N/AC:L/Au:N/C:N/I:N/A:C" }],
        database_specific: undefined,
      });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);

      // Canonical v2 base score for this vector
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.cvssScore).toBe(7.8);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.severity).toBe("high");
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

    it("for pypi, accepts ECOSYSTEM range type too (PEP 440 isn't semver — ADR 0022) but still ignores GIT", async () => {
      // Without this fix, every PyPI advisory would come back with
      // affectedVersions: [] and fixedVersion: null unconditionally, since
      // OSV represents PyPI ranges as ECOSYSTEM type, not SEMVER — this is
      // the actual regression this test guards against.
      const vuln = makeVuln({
        affected: [
          {
            ranges: [
              { type: "GIT", events: [{ introduced: "abc123" }] },
              { type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "2.31.0" }] },
            ],
          },
        ],
      });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("requests")], "pypi");
      const advisory = result.advisories.get("GHSA-xxxx-yyyy-zzzz");
      const ranges = advisory?.affectedVersions as { type: string }[];

      expect(ranges).toHaveLength(1);
      expect(ranges[0]?.type).toBe("ECOSYSTEM");
      expect(advisory?.fixedVersion).toBe("2.31.0");
    });

    it("for go, accepts SEMVER ranges (real Go module versions) but rejects ECOSYSTEM, unlike pypi (ADR 0024)", async () => {
      // Go is real SemVer, and OSV's own Go implementation is documented as
      // populating SEMVER-type ranges only — so unlike pypi, an ECOSYSTEM-
      // type range for go should be filtered out, not accepted.
      const vuln = makeVuln({
        affected: [
          {
            ranges: [
              { type: "GIT", events: [{ introduced: "abc123" }] },
              { type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "9.9.9" }] },
              { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.9.0" }] },
            ],
          },
        ],
      });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("github.com/foo/bar")], "go");
      const advisory = result.advisories.get("GHSA-xxxx-yyyy-zzzz");
      const ranges = advisory?.affectedVersions as { type: string }[];

      expect(ranges).toHaveLength(1);
      expect(ranges[0]?.type).toBe("SEMVER");
      expect(advisory?.fixedVersion).toBe("1.9.0");
    });

    it("stores empty affectedVersions array when no ranges exist", async () => {
      const vuln = makeVuln({ affected: [] });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.affectedVersions).toEqual([]);
    });

    it("uses only the queried package's own affected entry, ignoring a sibling package's ranges in the same record (real bug, CVE-2020-7919 / GO-2022-0229)", async () => {
      // Real shape, confirmed live during ADR 0024's Step 6 fixture
      // testing: a single OSV record can list multiple, unrelated
      // packages as separate "affected" entries. This CVE genuinely
      // covers both the Go toolchain/stdlib (fixed at Go release
      // "1.12.16" — a Go version, nothing to do with any module's own
      // versioning) and golang.org/x/crypto/cryptobyte (fixed at the
      // unrelated pseudo-version below) as two sibling entries. Before
      // this fix, querying for golang.org/x/crypto returned "1.12.16" as
      // its fixedVersion — a nonsensical, actively misleading
      // recommendation, not a hypothetical risk.
      const vuln = makeVuln({
        id: "GO-2022-0229",
        affected: [
          {
            package: { name: "stdlib", ecosystem: "Go" },
            ranges: [
              {
                type: "SEMVER",
                events: [{ introduced: "0" }, { fixed: "1.12.16" }],
              },
            ],
          },
          {
            package: { name: "golang.org/x/crypto", ecosystem: "Go" },
            ranges: [
              {
                type: "SEMVER",
                events: [{ introduced: "0" }, { fixed: "0.0.0-20200124225646-8b5121be2f68" }],
              },
            ],
          },
        ],
      });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("golang.org/x/crypto")], "go");
      const advisory = result.advisories.get("GO-2022-0229");

      expect(advisory?.fixedVersion).toBe("0.0.0-20200124225646-8b5121be2f68");
      expect(advisory?.affectedVersions).toHaveLength(1);
    });

    it("returns empty ranges when the vuln's affected array has entries, but none match the queried package", async () => {
      // Sibling-package-only case — the queried package genuinely isn't
      // one of the entries at all (shouldn't normally happen given how
      // the batch query itself is package-scoped, but the extraction
      // logic shouldn't silently borrow another package's data if it did).
      const vuln = makeVuln({
        affected: [
          {
            package: { name: "some-other-package", ecosystem: "npm" },
            ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "9.9.9" }] }],
          },
        ],
      });
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);
      const advisory = result.advisories.get("GHSA-xxxx-yyyy-zzzz");

      expect(advisory?.affectedVersions).toEqual([]);
      expect(advisory?.fixedVersion).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("fetchAdvisories — ecosystem parametrization (ADR 0022)", () => {
    it("defaults to npm when no ecosystem argument is passed", async () => {
      let capturedBody: string | null = null;
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string | URL, init?: RequestInit): Response => {
          if (init?.method === "POST") {
            capturedBody = init.body as string;
          }
          return new Response(JSON.stringify({ results: [{ vulns: [] }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );

      await fetcher.fetchAdvisories([dep("pkg")]);

      expect(capturedBody).not.toBeNull();
      const parsed = JSON.parse(capturedBody as unknown as string) as {
        queries: { package: { ecosystem: string } }[];
      };
      expect(parsed.queries[0]?.package.ecosystem).toBe("npm");
    });

    it("sends OSV's exact 'PyPI' ecosystem casing (not 'pypi') in the batch query", async () => {
      let capturedBody: string | null = null;
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string | URL, init?: RequestInit): Response => {
          if (init?.method === "POST") {
            capturedBody = init.body as string;
          }
          return new Response(JSON.stringify({ results: [{ vulns: [] }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );

      await fetcher.fetchAdvisories([dep("requests")], "pypi");

      const parsed = JSON.parse(capturedBody as unknown as string) as {
        queries: { package: { ecosystem: string } }[];
      };
      expect(parsed.queries[0]?.package.ecosystem).toBe("PyPI");
    });

    it("stores our internal ecosystem value ('pypi', not OSV's 'PyPI') on the advisory row", async () => {
      const vuln = makeVuln();
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("requests")], "pypi");

      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.ecosystem).toBe("pypi");
    });

    it("sends OSV's exact 'Go' ecosystem casing (not 'go') in the batch query", async () => {
      let capturedBody: string | null = null;
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string | URL, init?: RequestInit): Response => {
          if (init?.method === "POST") {
            capturedBody = init.body as string;
          }
          return new Response(JSON.stringify({ results: [{ vulns: [] }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );

      await fetcher.fetchAdvisories([dep("github.com/foo/bar")], "go");

      const parsed = JSON.parse(capturedBody as unknown as string) as {
        queries: { package: { ecosystem: string } }[];
      };
      expect(parsed.queries[0]?.package.ecosystem).toBe("Go");
    });

    it("stores our internal ecosystem value ('go', not OSV's 'Go') on the advisory row", async () => {
      const vuln = makeVuln();
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("github.com/foo/bar")], "go");

      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.ecosystem).toBe("go");
    });

    it("stores ecosystem: 'npm' on the advisory row by default", async () => {
      const vuln = makeVuln();
      vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

      const result = await fetcher.fetchAdvisories([dep("pkg")]);

      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.ecosystem).toBe("npm");
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
    it("throws a descriptive error on network failure, after the single retry", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      vi.stubGlobal("fetch", fetchMock);

      await expect(fetcher.fetchAdvisories([dep("pkg")])).rejects.toThrow(
        /OSV batch API.*network error/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("throws on non-200 HTTP response, after the single retry", async () => {
      const fetchMock = vi.fn((): Response => new Response("", { status: 429 }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(fetcher.fetchAdvisories([dep("pkg")])).rejects.toThrow(/HTTP 429/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not waste a retry on a permanent HTTP error", async () => {
      const fetchMock = vi.fn((): Response => new Response("", { status: 404 }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(fetcher.fetchAdvisories([dep("pkg")])).rejects.toThrow(/HTTP 404/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws when response body is not valid JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((): Response => new Response("not json", { status: 200 })),
      );

      await expect(fetcher.fetchAdvisories([dep("pkg")])).rejects.toThrow(/OSV batch API.*parse/);
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
  describe("fetchAdvisories — transient-failure retry (fetch-retry.ts)", () => {
    it("retries the batch query once after a 429 (honoring Retry-After) and succeeds", async () => {
      let postCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string | URL, init?: RequestInit): Response => {
          if (init?.method === "POST") {
            postCalls++;
            if (postCalls === 1) {
              return new Response("", { status: 429, headers: { "Retry-After": "0" } });
            }
            return new Response(JSON.stringify({ results: [{ vulns: [] }] }), { status: 200 });
          }
          return new Response("not found", { status: 404 });
        }),
      );

      const result = await fetcher.fetchAdvisories([dep("pkg")]);

      expect(postCalls).toBe(2);
      expect(result.advisories.size).toBe(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("retries the batch query on a network error and succeeds", async () => {
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string | URL, init?: RequestInit): Promise<Response> => {
          if (init?.method === "POST") {
            calls++;
            if (calls === 1) return Promise.reject(new Error("ECONNRESET"));
            return Promise.resolve(
              new Response(JSON.stringify({ results: [{ vulns: [] }] }), { status: 200 }),
            );
          }
          return Promise.resolve(new Response("not found", { status: 404 }));
        }),
      );

      const result = await fetcher.fetchAdvisories([dep("pkg")]);

      expect(calls).toBe(2);
      expect(result.warnings).toHaveLength(0);
    });

    it("retries a detail fetch that fails transiently and stores the advisory anyway", async () => {
      const vuln = makeVuln();
      let getCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string | URL, init?: RequestInit): Response => {
          if (init?.method === "POST") {
            return new Response(JSON.stringify({ results: [{ vulns: [{ id: vuln.id }] }] }), {
              status: 200,
            });
          }
          getCalls++;
          if (getCalls === 1) {
            return new Response("", { status: 503 });
          }
          return new Response(JSON.stringify(vuln), { status: 200 });
        }),
      );

      const result = await fetcher.fetchAdvisories([dep("pkg")]);

      expect(getCalls).toBe(2);
      expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")).toBeDefined();
      expect(result.warnings).toHaveLength(0);
    });

    it("gives up after the single retry when the detail fetch keeps failing transiently", async () => {
      let getCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string | URL, init?: RequestInit): Response => {
          if (init?.method === "POST") {
            return new Response(
              JSON.stringify({ results: [{ vulns: [{ id: "GHSA-flaky-0000" }] }] }),
              {
                status: 200,
              },
            );
          }
          getCalls++;
          return new Response("", { status: 503 });
        }),
      );

      const result = await fetcher.fetchAdvisories([dep("pkg")]);

      expect(getCalls).toBe(2);
      expect(result.advisories.size).toBe(0);
      expect(result.warnings.some((w) => w.includes("GHSA-flaky-0000"))).toBe(true);
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

describe("cvssVectorToBaseScore", () => {
  // Expected values are the NVD-published base scores for these exact
  // canonical vectors, not hand-derived — the formulas must reproduce
  // real calculator output or they're wrong in a way that only shows up
  // on production data.
  it.each([
    [
      "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
      9.8,
      "canonical critical RCE vector (log4shell's S:U twin)",
    ],
    [
      "CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H",
      10,
      "log4shell's exact vector, v3.0 prefix (same base formula as v3.1)",
    ],
    ["cvss:3.1/av:n/ac:l/pr:n/ui:n/s:u/c:h/i:h/a:h", 9.8, "case-insensitive parsing"],
    [
      "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H",
      8.8,
      "PR:L Scope Unchanged (NVD-verified: PrintNightmare CVE-2021-34527)",
    ],
    [
      "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H",
      9.9,
      "PR:L Scope Changed (the ubiquitous WordPress-plugin critical)",
    ],
    ["AV:N/AC:L/Au:N/C:N/I:N/A:C", 7.8, "unprefixed CVSS v2 vector, sniffed by its AU metric"],
    ["AV:N/AC:L/Au:S/C:C/I:C/A:C", 9, "CVSS v2 with authentication (NVD-verified shape)"],
  ])("%s → %s (%s)", (vector, expected) => {
    expect(cvssVectorToBaseScore(vector)).toBe(expected);
  });

  it("returns null for incomplete v3 vectors rather than guessing a partial score", () => {
    expect(cvssVectorToBaseScore("CVSS:3.1/AV:N/AC:L/PR:N/S:U/C:H/I:H")).toBeNull();
  });

  it("returns null for unrecognised metric values", () => {
    expect(cvssVectorToBaseScore("CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBeNull();
  });

  it("returns null for non-vector input", () => {
    expect(cvssVectorToBaseScore("7.5")).toBeNull();
    expect(cvssVectorToBaseScore("")).toBeNull();
    expect(cvssVectorToBaseScore("not-a-vector")).toBeNull();
  });
});

describe("cvssVectorToBaseScore — CVSS v4.0", () => {
  // Expected values are FIRST's own cvss-v4-calculator output for these
  // exact vectors (differentially verified 18/18 against the reference
  // implementation and cross-checked against the official Python `cvss`
  // library), not hand-derived — same discipline as the v2/v3 table above.
  // The first three are the CVSS_V4 vectors actually present in production
  // advisories (PYSEC-2026-*), which the previous behavior discarded to
  // severity "unknown" / impact floor 1.0.
  it.each([
    [
      "CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:N/VC:N/VI:N/VA:H/SC:N/SI:N/SA:H",
      8.9,
      "production vector (PYSEC-2026-1994/1998/4177): availability-only DoS",
    ],
    [
      "CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:P/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N",
      7.6,
      "production vector (PYSEC-2026-4175): C/I-high, exploit requires interaction",
    ],
    [
      "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:L/SC:N/SI:N/SA:N",
      6.9,
      "production vector (PYSEC-2026-4176): low availability impact only",
    ],
    [
      "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H",
      10,
      "full-impact network vector — the classic v4 10.0 shape",
    ],
    [
      "CVSS:4.0/AV:L/AC:L/AT:N/PR:H/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N",
      0,
      "no-impact shortcut: every impact metric N means zero regardless of AV",
    ],
    [
      "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:L/SA:N",
      8.7,
      "confidentiality-only partial impact",
    ],
    [
      "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:L/VI:H/VA:N/SC:L/SI:N/SA:N",
      8.8,
      "integrity-only partial impact",
    ],
    [
      "CVSS:4.0/AV:A/AC:H/AT:P/PR:L/UI:P/VC:L/VI:H/VA:L/SC:L/SI:L/SA:L",
      4.4,
      "adjacent/high-exploit-complexity dampening",
    ],
    [
      "CVSS:4.0/AV:P/AC:H/AT:P/PR:H/UI:A/VC:L/VI:L/VA:N/SC:H/SI:H/SA:H",
      2.4,
      "physical access worst case",
    ],
    [
      "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H/MSI:S/MSA:S",
      10,
      "environmental safety escalation (MSI:S/MSA:S)",
    ],
    [
      "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H/MAV:A/MAC:H",
      9,
      "modified base metrics override (MAV:A/MAC:H)",
    ],
    [
      "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H/E:U",
      9.1,
      "threat: exploit unlikely lowers the score",
    ],
    [
      "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H/E:P",
      9.3,
      "threat: PoC available lowers the score slightly",
    ],
    [
      "CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:P/VC:L/VI:H/VA:L/SC:L/SI:L/SA:L/E:P/MVI:L",
      2,
      "combined threat + modified-metric override",
    ],
  ])("%s → %s (%s)", (vector, expected) => {
    expect(cvssVectorToBaseScore(vector)).toBe(expected);
  });

  it("ignores supplemental metrics — they never change the base score", () => {
    const base = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N";
    expect(cvssVectorToBaseScore(`${base}/S:N/AU:N/R:A/V:D/RE:H/U:Green`)).toBe(
      cvssVectorToBaseScore(base),
    );
  });

  it("treats explicit X on threat/environmental metrics as their worst-case default", () => {
    const base = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H";
    expect(cvssVectorToBaseScore(`${base}/E:X/CR:X/IR:X/AR:X`)).toBe(cvssVectorToBaseScore(base));
  });

  it("returns null for invalid v4 vectors rather than guessing", () => {
    // Missing base metric
    expect(cvssVectorToBaseScore("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H")).toBeNull();
    // Value not in the metric's allowed set
    expect(
      cvssVectorToBaseScore("CVSS:4.0/AV:X/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H"),
    ).toBeNull();
    // Unknown metric (typo'd or future) — scoring a different vector than
    // the record carries would be silently wrong
    expect(
      cvssVectorToBaseScore(
        "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H/FOO:N",
      ),
    ).toBeNull();
    // Safety S is an MSI/MSA-only value — a base SI:S is not a legal v4 vector
    expect(
      cvssVectorToBaseScore("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:S/SA:N"),
    ).toBeNull();
    // CVSS 4.1+ must not be scored with the v4.0 tables
    expect(
      cvssVectorToBaseScore("CVSS:4.1/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H"),
    ).toBeNull();
  });
});

describe("OsvFetcher — version-filtered batch queries (ADR 0038 resolution)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function depWithVersion(package_name: string, resolved_version: string | null): ParsedDependency {
    return { package_name, version_spec: "^1.0.0", dep_type: "production", resolved_version };
  }

  it("carries the resolved version in the batch query and reports versionMatchedPackages", async () => {
    const batchBody: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL, init?: RequestInit): Response => {
        if (init?.method === "POST") {
          const parsed = JSON.parse(init.body as string) as { queries: unknown[] };
          batchBody.push(...parsed.queries);
          return new Response(JSON.stringify({ results: [{ vulns: [] }] }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const fetcher = new OsvFetcher(undefined, undefined, undefined, 0, undefined, false);
    const result = await fetcher.fetchAdvisories(
      [depWithVersion("lodash", "4.17.20"), depWithVersion("left-pad", null)],
      "npm",
    );

    expect(batchBody).toEqual([
      { package: { name: "lodash", ecosystem: "npm" }, version: "4.17.20" },
      { package: { name: "left-pad", ecosystem: "npm" } },
    ]);
    expect(result.versionMatchedPackages).toEqual(new Set(["lodash"]));
  });

  it("uses name-only queries when no dependency has a resolved version", async () => {
    const batchBody: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL, init?: RequestInit): Response => {
        if (init?.method === "POST") {
          const parsed = JSON.parse(init.body as string) as { queries: unknown[] };
          batchBody.push(...parsed.queries);
          return new Response(JSON.stringify({ results: [{ vulns: [] }] }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const fetcher = new OsvFetcher(undefined, undefined, undefined, 0, undefined, false);
    const result = await fetcher.fetchAdvisories(
      [depWithVersion("lodash", null), dep("left-pad")],
      "npm",
    );

    expect(batchBody).toEqual([
      { package: { name: "lodash", ecosystem: "npm" } },
      { package: { name: "left-pad", ecosystem: "npm" } },
    ]);
    expect(result.versionMatchedPackages.size).toBe(0);
  });

  it("deduplicates a package's dep_type rows to one resolved version", async () => {
    const batchBody: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL, init?: RequestInit): Response => {
        if (init?.method === "POST") {
          const parsed = JSON.parse(init.body as string) as { queries: unknown[] };
          batchBody.push(...parsed.queries);
          return new Response(JSON.stringify({ results: [{ vulns: [] }] }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const fetcher = new OsvFetcher(undefined, undefined, undefined, 0, undefined, false);
    await fetcher.fetchAdvisories(
      [
        depWithVersion("lodash", "4.17.20"),
        { package_name: "lodash", version_spec: "^4.17.0", dep_type: "development" },
      ],
      "npm",
    );

    // One query per unique package (dedup), carrying the first-seen version.
    expect(batchBody).toEqual([
      { package: { name: "lodash", ecosystem: "npm" }, version: "4.17.20" },
    ]);
  });
});

describe("OsvFetcher — EPSS enrichment wiring (ADR 0039)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the EPSS fetcher and stamps epssScore onto returned advisories", async () => {
    const vuln = makeVuln({ aliases: ["CVE-2024-3094"] });
    vi.stubGlobal("fetch", mockOsvApiForVulns([[vuln]]));

    const epssFetcher = new EpssFetcher("https://epss.test", 1, 0);
    const epssSpy = vi
      .spyOn(epssFetcher, "fetchScores")
      .mockResolvedValue({ scores: new Map([["CVE-2024-3094", 0.909]]), warnings: [] });

    const fetcher = new OsvFetcher(undefined, undefined, undefined, 0, epssFetcher);
    const result = await fetcher.fetchAdvisories([dep("lodash")]);

    expect(epssSpy).toHaveBeenCalledTimes(1);
    expect(epssSpy.mock.calls[0]?.[0]).toEqual(["CVE-2024-3094"]);
    expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.epssScore).toBeCloseTo(0.909, 6);
  });

  it("still returns advisories when the EPSS fetcher warns (non-fatal)", async () => {
    vi.stubGlobal("fetch", mockOsvApiForVulns([[makeVuln({ aliases: ["CVE-2024-3094"] })]]));

    const epssFetcher = new EpssFetcher("https://epss.test", 1, 0);
    vi.spyOn(epssFetcher, "fetchScores").mockResolvedValue({
      scores: new Map(),
      warnings: [
        "EPSS fetch failed for a batch of 1 CVE(s): 500. Those advisories keep no EPSS score this run.",
      ],
    });

    const fetcher = new OsvFetcher(undefined, undefined, undefined, 0, epssFetcher);
    const result = await fetcher.fetchAdvisories([dep("lodash")]);

    expect(result.advisories.size).toBe(1);
    expect(result.advisories.get("GHSA-xxxx-yyyy-zzzz")?.epssScore).toBeUndefined();
    expect(result.warnings.some((w) => w.includes("EPSS"))).toBe(true);
  });
});
