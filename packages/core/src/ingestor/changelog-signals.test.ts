/**
 * changelog-signals.ts unit tests
 *
 * All network calls are mocked via vi.stubGlobal. Covers: hard-stop cases
 * (no target, unparseable target, 404, network failure), range bounding
 * (floor/target, prerelease/draft skipping, unparseable-tag skipping,
 * pagination cap), signal extraction (migration-guide mentions, inline
 * BREAKING CHANGE: lines, heading-section bullets, the 5-entry cap, 200-char
 * truncation), the source_available/confidence-flag distinction (ADR 0029
 * Decision 4), and prefetchEffortSignals' dedup + null-sourceRepo shortcut.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchReleaseSignals,
  prefetchEffortSignals,
  UNAVAILABLE_SIGNALS,
  type EffortSignalRequest,
} from "./changelog-signals.js";
import type { SourceRepoRef } from "./source-repo.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repo(owner = "owner", name = "repo"): SourceRepoRef {
  return { owner, name };
}

interface ReleaseOpts {
  tag_name: string;
  body?: string;
  prerelease?: boolean;
  draft?: boolean;
}

function release(opts: ReleaseOpts): Record<string, unknown> {
  return {
    tag_name: opts.tag_name,
    body: opts.body ?? "",
    prerelease: opts.prerelease ?? false,
    draft: opts.draft ?? false,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// fetchReleaseSignals
// ---------------------------------------------------------------------------

describe("fetchReleaseSignals", () => {
  describe("hard-stop cases — never call fetch, or return unavailable", () => {
    it("returns unavailable with no fetch call when targetVersion is null", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchReleaseSignals(repo(), "npm", null, null, null);

      expect(result).toEqual(UNAVAILABLE_SIGNALS);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns unavailable with no fetch call when targetVersion doesn't parse", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchReleaseSignals(repo(), "npm", null, "not-a-version", null);

      expect(result).toEqual(UNAVAILABLE_SIGNALS);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns unavailable on a 404 (repo doesn't exist or has Releases disabled)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

      const result = await fetchReleaseSignals(repo(), "npm", null, "1.0.0", null);

      expect(result).toEqual(UNAVAILABLE_SIGNALS);
    });

    it("returns unavailable on a network failure with nothing gathered yet", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const result = await fetchReleaseSignals(repo(), "npm", null, "1.0.0", null);

      expect(result).toEqual(UNAVAILABLE_SIGNALS);
    });

    it("returns unavailable on a rate limit (403) with nothing gathered yet", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));

      const result = await fetchReleaseSignals(repo(), "npm", null, "1.0.0", null);

      expect(result).toEqual(UNAVAILABLE_SIGNALS);
    });
  });

  describe("source_available semantics (ADR 0029 Decision 4)", () => {
    it("is true when the repo genuinely has zero releases — a real, checked answer", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));

      const result = await fetchReleaseSignals(repo(), "npm", null, "1.0.0", null);

      expect(result.source_available).toBe(true);
      expect(result.has_migration_guide).toBe(false);
      expect(result.breaking_change_signals).toEqual([]);
    });

    it("returns partial data (and source_available: true) from a later-page failure", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse([release({ tag_name: "v2.0.0", body: "BREAKING CHANGE: page one." })]),
        )
        .mockRejectedValueOnce(new Error("ECONNRESET"));
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchReleaseSignals(repo(), "npm", "0.9.0", "2.0.0", null);

      expect(result.source_available).toBe(true);
      expect(result.breaking_change_signals).toEqual(["page one."]);
    });
  });

  describe("signal extraction", () => {
    it("detects a migration guide mention", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            jsonResponse([
              release({ tag_name: "v5.0.0", body: "See the migration guide for details." }),
            ]),
          ),
      );

      const result = await fetchReleaseSignals(repo(), "npm", "4.0.0", "5.0.0", null);

      expect(result.has_migration_guide).toBe(true);
    });

    it("does not flag a migration guide when there's no such mention", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(jsonResponse([release({ tag_name: "v5.0.0", body: "Bug fixes." })])),
      );

      const result = await fetchReleaseSignals(repo(), "npm", "4.0.0", "5.0.0", null);

      expect(result.has_migration_guide).toBe(false);
    });

    it("extracts an inline 'BREAKING CHANGE:' line", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse([
            release({
              tag_name: "v5.0.0",
              body: "Some notes.\nBREAKING CHANGE: removed the old API.\nMore notes.",
            }),
          ]),
        ),
      );

      const result = await fetchReleaseSignals(repo(), "npm", "4.0.0", "5.0.0", null);

      expect(result.breaking_change_signals).toEqual(["removed the old API."]);
    });

    it("extracts bullets from a 'Breaking Changes' heading section, stopping at the next heading", async () => {
      const body = [
        "## Breaking Changes",
        "- Removed `foo()`",
        "- Renamed `bar` to `baz`",
        "## Other changes",
        "- Fixed a typo",
      ].join("\n");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse([release({ tag_name: "v5.0.0", body })])),
      );

      const result = await fetchReleaseSignals(repo(), "npm", "4.0.0", "5.0.0", null);

      expect(result.breaking_change_signals).toEqual(["Removed `foo()`", "Renamed `bar` to `baz`"]);
    });

    it("caps breaking_change_signals at 5 entries", async () => {
      const body = [
        "## Breaking Changes",
        "- one",
        "- two",
        "- three",
        "- four",
        "- five",
        "- six",
      ].join("\n");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse([release({ tag_name: "v5.0.0", body })])),
      );

      const result = await fetchReleaseSignals(repo(), "npm", "4.0.0", "5.0.0", null);

      expect(result.breaking_change_signals).toHaveLength(5);
      expect(result.breaking_change_signals).not.toContain("six");
    });

    it("truncates an overly long signal line to 200 chars with an ellipsis", async () => {
      const longLine = "x".repeat(300);
      const body = `## Breaking Changes\n- ${longLine}`;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse([release({ tag_name: "v5.0.0", body })])),
      );

      const result = await fetchReleaseSignals(repo(), "npm", "4.0.0", "5.0.0", null);

      expect(result.breaking_change_signals[0]).toHaveLength(200);
      expect(result.breaking_change_signals[0]?.endsWith("…")).toBe(true);
    });
  });

  describe("range bounding", () => {
    it("skips releases newer than targetVersion", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            jsonResponse([
              release({ tag_name: "v6.0.0", body: "BREAKING CHANGE: from the future." }),
              release({ tag_name: "v5.0.0", body: "BREAKING CHANGE: the real target release." }),
            ]),
          ),
      );

      const result = await fetchReleaseSignals(repo(), "npm", "4.0.0", "5.0.0", null);

      expect(result.breaking_change_signals).toEqual(["the real target release."]);
    });

    it("excludes releases at or below currentFloor", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            jsonResponse([
              release({ tag_name: "v5.0.0", body: "BREAKING CHANGE: in range." }),
              release({ tag_name: "v4.0.0", body: "BREAKING CHANGE: at the floor, excluded." }),
              release({ tag_name: "v3.0.0", body: "BREAKING CHANGE: below the floor, excluded." }),
            ]),
          ),
      );

      const result = await fetchReleaseSignals(repo(), "npm", "4.0.0", "5.0.0", null);

      expect(result.breaking_change_signals).toEqual(["in range."]);
    });

    it("has no lower bound at all when currentFloor is null", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            jsonResponse([
              release({ tag_name: "v2.0.0", body: "BREAKING CHANGE: still included." }),
            ]),
          ),
      );

      const result = await fetchReleaseSignals(repo(), "npm", null, "5.0.0", null);

      expect(result.breaking_change_signals).toEqual(["still included."]);
    });

    it("skips prerelease and draft entries", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse([
            release({
              tag_name: "v5.0.0-beta.1",
              body: "BREAKING CHANGE: prerelease, excluded.",
              prerelease: true,
            }),
            release({
              tag_name: "v5.0.0-draft",
              body: "BREAKING CHANGE: draft, excluded.",
              draft: true,
            }),
            release({ tag_name: "v5.0.0", body: "BREAKING CHANGE: the real one." }),
          ]),
        ),
      );

      const result = await fetchReleaseSignals(repo(), "npm", "4.0.0", "5.0.0", null);

      expect(result.breaking_change_signals).toEqual(["the real one."]);
    });

    it("skips releases whose tag doesn't parse as a version for this ecosystem", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            jsonResponse([
              release({ tag_name: "nightly", body: "BREAKING CHANGE: not a real version tag." }),
              release({ tag_name: "v5.0.0", body: "BREAKING CHANGE: the real one." }),
            ]),
          ),
      );

      const result = await fetchReleaseSignals(repo(), "npm", "4.0.0", "5.0.0", null);

      expect(result.breaking_change_signals).toEqual(["the real one."]);
    });

    it("resolves correctly for PyPI's PEP 440 version ordering, not just semver", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            jsonResponse([
              release({ tag_name: "6.0.0", body: "BREAKING CHANGE: pypi in range." }),
              release({ tag_name: "5.0.0", body: "BREAKING CHANGE: pypi at floor, excluded." }),
            ]),
          ),
      );

      const result = await fetchReleaseSignals(repo(), "pypi", "5.0.0", "6.0.0", null);

      expect(result.breaking_change_signals).toEqual(["pypi in range."]);
    });
  });

  describe("pagination", () => {
    it("stops once an empty page is returned", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([release({ tag_name: "v1.0.0" })]))
        .mockResolvedValueOnce(jsonResponse([]));
      vi.stubGlobal("fetch", fetchMock);

      await fetchReleaseSignals(repo(), "npm", null, "1.0.0", null);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("stops after 5 pages even if the floor is never reached", async () => {
      // No floor at all (null) and every page returns 100 fresh-looking
      // releases, all <= target — nothing ever ends pagination early
      // except the page cap itself. mockImplementation (not
      // mockResolvedValue) because a Response body is a single-use
      // stream — reusing one Response instance across calls would make
      // page 2's .json() throw on the already-consumed body, which
      // would end pagination early for the wrong reason entirely.
      const fetchMock = vi
        .fn()
        .mockImplementation(() =>
          jsonResponse(
            Array.from({ length: 100 }, (_, i) => release({ tag_name: `v0.${String(99 - i)}.0` })),
          ),
        );
      vi.stubGlobal("fetch", fetchMock);

      await fetchReleaseSignals(repo(), "npm", null, "0.99.0", null);

      expect(fetchMock).toHaveBeenCalledTimes(5);
    });
  });

  describe("auth", () => {
    it("sends an Authorization header when a token is provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
      vi.stubGlobal("fetch", fetchMock);

      await fetchReleaseSignals(repo(), "npm", null, "1.0.0", "gh-token-abc");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gh-token-abc");
    });

    it("omits the Authorization header when no token is provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
      vi.stubGlobal("fetch", fetchMock);

      await fetchReleaseSignals(repo(), "npm", null, "1.0.0", null);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// prefetchEffortSignals
// ---------------------------------------------------------------------------

describe("prefetchEffortSignals", () => {
  function req(overrides: Partial<EffortSignalRequest> = {}): EffortSignalRequest {
    return {
      key: "dep-1:1.0.0",
      sourceRepo: repo(),
      ecosystem: "npm",
      currentFloor: null,
      targetVersion: "1.0.0",
      ...overrides,
    };
  }

  it("returns an empty map for an empty request list, no fetch calls", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await prefetchEffortSignals([], null);

    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves unavailable with zero fetch calls when sourceRepo is null", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await prefetchEffortSignals([req({ sourceRepo: null })], null);

    expect(result.get("dep-1:1.0.0")).toEqual(UNAVAILABLE_SIGNALS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dedupes two requests sharing the same key into a single fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await prefetchEffortSignals([req(), req()], null);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(1);
  });

  it("resolves distinct keys independently", async () => {
    // mockImplementation, not mockResolvedValue — two real concurrent
    // fetch calls happen here (distinct keys, no dedup), and a shared
    // Response instance's body can only be read once. See the pagination
    // test above for the failure mode this avoids.
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await prefetchEffortSignals(
      [req({ key: "dep-1:1.0.0" }), req({ key: "dep-2:2.0.0", targetVersion: "2.0.0" })],
      null,
    );

    expect(result.size).toBe(2);
    expect(result.get("dep-1:1.0.0")?.source_available).toBe(true);
    expect(result.get("dep-2:2.0.0")?.source_available).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("respects the concurrency limit (at most `concurrency` in flight)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return jsonResponse([]);
      }),
    );

    const requests = Array.from({ length: 8 }, (_, i) => req({ key: `dep-${String(i)}:1.0.0` }));
    await prefetchEffortSignals(requests, null, 2);

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
