/**
 * EPSS fetcher tests — ADR 0039.
 *
 * The mock EPSS response shape mirrors the live API (verified 2026-10-22:
 * {"status":"OK","total":N,"data":[{"cve":"CVE-…","epss":"0.909…",
 * "percentile":"…","date":"…"}]}, unknown CVE ids silently omitted from
 * `data`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewAdvisory } from "../db/schema.js";
import { EpssFetcher, enrichAdvisoriesWithEpss, extractCveIds } from "./epss.js";

/** Live-API-shaped EPSS response for a set of (cve, score) pairs. */
function epssBody(entries: { cve: string; epss: string }[]): string {
  return JSON.stringify({
    status: "OK",
    "status-code": 200,
    version: "1.0",
    access: "public",
    total: entries.length,
    offset: 0,
    limit: 100,
    data: entries,
  });
}

function advisory(
  osvId: string,
  aliases: string[] | undefined,
  overrides: Partial<NewAdvisory> = {},
): NewAdvisory {
  return {
    osvId,
    source: "ghsa",
    ecosystem: "npm",
    packageName: "lodash",
    severity: "high",
    cvssScore: 7.5,
    summary: `Advisory ${osvId}`,
    details: null,
    affectedVersions: [],
    fixedVersion: "4.17.21",
    publishedAt: new Date("2024-01-10T00:00:00Z"),
    modifiedAt: new Date("2024-01-15T00:00:00Z"),
    rawData: aliases === undefined ? {} : { aliases },
    ...overrides,
  };
}

describe("extractCveIds", () => {
  it("collects unique CVE aliases in first-seen order", () => {
    const ids = extractCveIds([
      advisory("GHSA-1", ["CVE-2021-44228", "GHSA-jfh8-c2jp-5v3q"]),
      advisory("GHSA-2", ["CVE-2021-44228", "CVE-2024-3094"]),
      advisory("GHSA-3", undefined),
      advisory("GHSA-4", []),
      advisory("GHSA-5", ["not-a-cve", "cve-2020-0001"]),
    ]);
    expect(ids).toEqual(["CVE-2021-44228", "CVE-2024-3094"]);
  });

  it("returns empty for advisories without aliases", () => {
    expect(extractCveIds([advisory("GHSA-1", undefined)])).toEqual([]);
  });
});

describe("EpssFetcher.fetchScores", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL): Response => {
        const text = url.toString();
        if (text.includes("CVE-2024-3094")) {
          return new Response(epssBody([{ cve: "CVE-2024-3094", epss: "0.909000000" }]), {
            status: 200,
          });
        }
        if (text.includes("CVE-0000-0000")) {
          // Known id omitted from data — the live API's unknown-id behavior
          return new Response(epssBody([]), { status: 200 });
        }
        if (text.includes("CVE-7777-7777")) {
          return new Response("server error", { status: 500 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns empty for an empty id list without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await new EpssFetcher(undefined, undefined, 0).fetchScores([]);
    expect(result.scores.size).toBe(0);
    expect(result.warnings).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scores a CVE from the live response shape", async () => {
    const result = await new EpssFetcher(undefined, undefined, 0).fetchScores(["CVE-2024-3094"]);
    expect(result.scores.get("CVE-2024-3094")).toBeCloseTo(0.909, 6);
    expect(result.warnings).toHaveLength(0);
  });

  it("omits unknown CVE ids silently — no score, no warning", async () => {
    const result = await new EpssFetcher(undefined, undefined, 0).fetchScores(["CVE-0000-0000"]);
    expect(result.scores.size).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns (never throws) on a failing batch", async () => {
    const result = await new EpssFetcher(undefined, undefined, 0).fetchScores(["CVE-7777-7777"]);
    expect(result.scores.size).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("CVE(s)");
  });

  it("rejects out-of-range probabilities with a warning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Response(
            JSON.stringify({
              status: "OK",
              data: [{ cve: "CVE-2024-3094", epss: "1.5" }],
            }),
            { status: 200 },
          ),
      ),
    );
    const result = await new EpssFetcher(undefined, undefined, 0).fetchScores(["CVE-2024-3094"]);
    expect(result.scores.size).toBe(0);
    expect(result.warnings[0]).toContain("unparseable probability");
  });

  it("chunks more than 100 CVEs into multiple requests", async () => {
    const fetchMock = vi.fn(() => new Response(epssBody([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ids = Array.from(
      { length: 250 },
      (_, i) => `CVE-2026-${String(1000 + i).padStart(4, "0")}`,
    );
    const result = await new EpssFetcher(undefined, undefined, 0).fetchScores(ids);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 100 + 100 + 50
    expect(result.scores.size).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });
});

describe("enrichAdvisoriesWithEpss", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stamps epssScore onto advisories via their CVE aliases", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Response(epssBody([{ cve: "CVE-2021-44228", epss: "0.999990000" }]), { status: 200 }),
      ),
    );
    const map = new Map<string, NewAdvisory>([
      ["GHSA-jfh8-c2jp-5v3q", advisory("GHSA-jfh8-c2jp-5v3q", ["CVE-2021-44228"])],
    ]);
    const warnings: string[] = [];
    await enrichAdvisoriesWithEpss(map, warnings);
    expect(map.get("GHSA-jfh8-c2jp-5v3q")?.epssScore).toBeCloseTo(0.99999, 6);
    expect(warnings).toHaveLength(0);
  });

  it("leaves epssScore unset when the advisory has no CVE alias", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const map = new Map<string, NewAdvisory>([
      ["GHSA-noalias", advisory("GHSA-noalias", undefined)],
    ]);
    const warnings: string[] = [];
    await enrichAdvisoriesWithEpss(map, warnings);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(map.get("GHSA-noalias")?.epssScore).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  it("keeps epssScore unset when EPSS returns nothing for the CVE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response(epssBody([]), { status: 200 })),
    );
    const map = new Map<string, NewAdvisory>([["GHSA-x", advisory("GHSA-x", ["CVE-1111-1111"])]]);
    const warnings: string[] = [];
    await enrichAdvisoriesWithEpss(map, warnings);
    expect(map.get("GHSA-x")?.epssScore).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  it("keeps epssScore unset and warns when the EPSS fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response("server error", { status: 500 })),
    );
    const map = new Map<string, NewAdvisory>([["GHSA-x", advisory("GHSA-x", ["CVE-2021-44228"])]]);
    const warnings: string[] = [];
    // Zero retry backoff — the 30s default is production pacing, not logic.
    await enrichAdvisoriesWithEpss(map, warnings, new EpssFetcher(undefined, undefined, 0));
    expect(map.get("GHSA-x")?.epssScore).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });
});
