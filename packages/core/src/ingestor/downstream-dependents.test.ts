/**
 * downstream-dependents.ts unit tests
 *
 * All network calls are mocked via vi.stubGlobal. Covers: hard-stop cases
 * (no key, 404), the monorepo max rule, genuine-zero vs unavailable
 * semantics (ADR 0032), failure paths (network error, non-ok status,
 * malformed body), 429 retry behavior, request-shape contract (URL,
 * api_key), and client-side pacing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDownstreamDependents, type RepoRef } from "./downstream-dependents.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repo(owner = "owner", name = "repo"): RepoRef {
  return { owner, name };
}

/** Every non-pacing test passes NO_WAIT so module-level pacing never leaks between tests. */
const NO_WAIT = { minIntervalMs: 0 };

function project(dependents_count: number): Record<string, unknown> {
  return { name: `pkg-${String(dependents_count)}`, dependents_count };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    ...(headers !== undefined && { headers }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// fetchDownstreamDependents
// ---------------------------------------------------------------------------

describe("fetchDownstreamDependents", () => {
  describe("hard-stop cases — never call fetch", () => {
    it("returns unavailable with no fetch call when the API key is null", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchDownstreamDependents(repo(), null, NO_WAIT);

      expect(result.count).toBeNull();
      expect(result.warnings).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns unavailable with no fetch call when the API key is an empty string", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchDownstreamDependents(repo(), "", NO_WAIT);

      expect(result.count).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("request shape", () => {
    it("hits /api/github/{owner}/{name}/projects with api_key and paging params", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
      vi.stubGlobal("fetch", fetchMock);

      await fetchDownstreamDependents(repo("lodash", "lodash"), "lio-key-abc", NO_WAIT);

      const [url] = fetchMock.mock.calls[0] as unknown[] as [string];
      expect(url).toBe(
        "https://libraries.io/api/github/lodash/lodash/projects?api_key=lio-key-abc&per_page=100&page=1",
      );
    });

    it("percent-encodes owner and name", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
      vi.stubGlobal("fetch", fetchMock);

      await fetchDownstreamDependents(repo("own er", "na/me"), "k", NO_WAIT);

      const [url] = fetchMock.mock.calls[0] as unknown[] as [string];
      expect(url).toContain("/github/own%20er/na%2Fme/projects");
    });
  });

  describe("count resolution", () => {
    it("resolves the single linked project's dependents_count", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([project(4_320)])));

      const result = await fetchDownstreamDependents(repo(), "k", NO_WAIT);

      expect(result.count).toBe(4_320);
      expect(result.warnings).toEqual([]);
    });

    it("takes the max across multiple linked packages (monorepo rule)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse([project(12), project(9_876), project(500)])),
      );

      const result = await fetchDownstreamDependents(repo(), "k", NO_WAIT);

      expect(result.count).toBe(9_876);
    });

    it("resolves a genuine 0 for a published package nobody depends on", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([project(0)])));

      const result = await fetchDownstreamDependents(repo(), "k", NO_WAIT);

      // A real, checked answer — distinct from null ("couldn't check").
      // deriveConfidenceFlags clears downstream_dependents_unavailable on
      // this outcome (ADR 0032).
      expect(result.count).toBe(0);
      expect(result.warnings).toEqual([]);
    });

    it("treats an empty project list as unavailable, not zero", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));

      const result = await fetchDownstreamDependents(repo(), "k", NO_WAIT);

      // An app repo that publishes nothing has no package to count
      // dependents OF — ADR 0006's never-default-to-zero rule.
      expect(result.count).toBeNull();
      expect(result.warnings).toEqual([]);
    });

    it("treats a list with no usable dependents_count entries as unavailable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse([{ name: "no-count" }, { dependents_count: "12" }])),
      );

      const result = await fetchDownstreamDependents(repo(), "k", NO_WAIT);

      expect(result.count).toBeNull();
      expect(result.warnings).toEqual([]);
    });
  });

  describe("pagination (live-verified contract: default page size is 30, per_page=100 honored)", () => {
    function fullPage(bestCount: number): unknown[] {
      // 100 entries = a full page, so the scan continues to the next one.
      return Array.from({ length: 100 }, (_, i) => project(i === 99 ? bestCount : i));
    }

    it("follows pages until an empty page and takes the max across all of them", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation((url: string) =>
          jsonResponse(url.includes("page=2") ? [project(42), project(9_999)] : fullPage(500)),
        );
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchDownstreamDependents(repo(), "k", NO_WAIT);

      expect(result.count).toBe(9_999);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [secondUrl] = fetchMock.mock.calls[1] as unknown[] as [string];
      expect(secondUrl).toContain("page=2");
    });

    it("stops when a partial page comes back (< PER_PAGE items)", async () => {
      const fetchMock = vi.fn().mockImplementation(() => jsonResponse([project(7)]));
      vi.stubGlobal("fetch", fetchMock);

      await fetchDownstreamDependents(repo(), "k", NO_WAIT);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("degrades to unavailable with a warning when the scan hits the page cap on a still-full page", async () => {
      // 5 consecutive full pages = MAX_PAGES reached without seeing the
      // end of the listing — a truncated max can't be trusted as real,
      // checked data, so nothing is stored.
      const fetchMock = vi.fn().mockImplementation(() => jsonResponse(fullPage(123)));
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchDownstreamDependents(repo(), "k", NO_WAIT);

      expect(result.count).toBeNull();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("exceeded");
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it("degrades to unavailable with a warning when a later page fails — a partial max would be misleadingly low", async () => {
      // Under the shared transport policy the failing page fetch itself gets
      // one recovery shot; the base mock keeps rejecting, so the scan still
      // discards everything and reports unavailable.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(fullPage(500)))
        .mockRejectedValue(new Error("ECONNRESET"));
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchDownstreamDependents(repo(), "k", {
        ...NO_WAIT,
        rateLimitRetryDelayMs: 1,
      });

      expect(result.count).toBeNull();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("network error");
    });

    it("keeps page-1-only silent-null semantics for a 404", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchDownstreamDependents(repo(), "k", NO_WAIT);

      expect(result.count).toBeNull();
      expect(result.warnings).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("unavailable outcomes", () => {
    it("returns unavailable silently on a 404 (repo unknown to libraries.io)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

      const result = await fetchDownstreamDependents(repo(), "k", NO_WAIT);

      expect(result.count).toBeNull();
      expect(result.warnings).toEqual([]);
    });

    it("warns and returns unavailable on another non-ok status after the single retry", async () => {
      // 5xx is transient under the shared transport policy — the stub keeps
      // answering 500, so the retry fails identically and the page scan
      // still degrades to unavailable.
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchDownstreamDependents(repo(), "k", {
        ...NO_WAIT,
        rateLimitRetryDelayMs: 1,
      });

      expect(result.count).toBeNull();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("HTTP 500");
    });

    it("warns and returns unavailable on a network failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const result = await fetchDownstreamDependents(repo(), "k", {
        ...NO_WAIT,
        rateLimitRetryDelayMs: 1,
      });

      expect(result.count).toBeNull();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("network error");
    });

    it("warns and returns unavailable when the body isn't valid JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("<html>gateway timeout</html>", { status: 200 })),
      );

      const result = await fetchDownstreamDependents(repo(), "k", NO_WAIT);

      expect(result.count).toBeNull();
      expect(result.warnings).toHaveLength(1);
    });

    it("warns and returns unavailable when the body isn't an array", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "nope" })));

      const result = await fetchDownstreamDependents(repo(), "k", NO_WAIT);

      expect(result.count).toBeNull();
      expect(result.warnings).toHaveLength(1);
    });
  });

  describe("rate limiting", () => {
    it("retries once after a 429 and succeeds", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 429 }))
        .mockResolvedValueOnce(jsonResponse([project(77)]));
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchDownstreamDependents(repo(), "k", {
        ...NO_WAIT,
        rateLimitRetryDelayMs: 1,
      });

      expect(result.count).toBe(77);
      expect(result.warnings).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("honors a numeric Retry-After header over the fallback delay", async () => {
      vi.useFakeTimers();
      try {
        // Retry-After: 5s, fallback deliberately huge — if the fallback
        // were used, advancing 5s wouldn't be enough and this would hang.
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(
            new Response(null, { status: 429, headers: { "Retry-After": "5" } }),
          )
          .mockResolvedValueOnce(jsonResponse([project(7)]));
        vi.stubGlobal("fetch", fetchMock);

        const pending = fetchDownstreamDependents(repo(), "k", {
          minIntervalMs: 0,
          rateLimitRetryDelayMs: 600_000,
        });
        await vi.advanceTimersByTimeAsync(5_001);

        const result = await pending;
        expect(result.count).toBe(7);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives up with a warning when the retry is also rate-limited", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 429 })));

      const result = await fetchDownstreamDependents(repo(), "k", {
        ...NO_WAIT,
        rateLimitRetryDelayMs: 1,
      });

      expect(result.count).toBeNull();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("HTTP 429");
    });

    it("does not retry a plain 403 (transient-elsewhere status, no Retry-After)", async () => {
      // The shared transport policy retries 429/5xx/network errors — but a
      // bare 403 (actually forbidden) carries no Retry-After and gets no
      // second attempt. GitHub's 403-WITH-Retry-After secondary-limit shape
      // is the pinned counter-case in fetch-retry.test.ts.
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
      vi.stubGlobal("fetch", fetchMock);

      await fetchDownstreamDependents(repo(), "k", NO_WAIT);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("pacing", () => {
    it("waits at least minIntervalMs between consecutive calls", async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = vi.fn().mockImplementation(() => jsonResponse([]));
        vi.stubGlobal("fetch", fetchMock);

        await fetchDownstreamDependents(repo("first", "call"), "k", { minIntervalMs: 1_000 });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        let secondDone = false;
        const second = fetchDownstreamDependents(repo("second", "call"), "k", {
          minIntervalMs: 1_000,
        }).then((r) => {
          secondDone = true;
          return r;
        });

        await vi.advanceTimersByTimeAsync(999);
        expect(secondDone).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(2);
        await second;
        expect(secondDone).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
