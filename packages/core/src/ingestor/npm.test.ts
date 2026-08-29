/**
 * NpmIngestor unit tests
 *
 * Uses Vitest's built-in fetch mocking via vi.stubGlobal so no network
 * calls are made. Each test group covers one behavioural contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NpmIngestor } from "./npm.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "https://raw.githubusercontent.com/owner/repo/main";

/** Build a minimal fetch mock that returns different responses per URL */
function mockFetch(
  responses: Record<string, { status: number; body?: string }>,
): (input: string | URL, init?: RequestInit) => Response {
  return vi.fn((input: string | URL, init?: RequestInit): Response => {
    const url = input.toString();
    const match = responses[url];

    if (!match) {
      return new Response(null, { status: 404 });
    }

    // HEAD requests have no body
    if (init?.method === "HEAD") {
      return new Response(null, { status: match.status });
    }

    return new Response(match.body ?? "", { status: match.status });
  });
}

function packageJsonUrl(base = BASE): string {
  return `${base}/package.json`;
}

function lockUrl(name: string, base = BASE): string {
  return `${base}/${name}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NpmIngestor", () => {
  let ingestor: NpmIngestor;

  beforeEach(() => {
    // Transport backoff/deadline disabled — failure-path tests below stub a
    // rejecting fetch and must not sleep through the real 30 s policy.
    ingestor = new NpmIngestor({ retryDelayMs: 0, timeoutMs: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  it("has the correct ecosystem property", () => {
    expect(ingestor.ecosystem).toBe("npm");
  });

  // -------------------------------------------------------------------------
  describe("parseDependencies — happy path", () => {
    it("parses all four dependency sections", async () => {
      const pkg = JSON.stringify({
        dependencies: { react: "^18.0.0", lodash: "^4.17.21" },
        devDependencies: { vitest: "^2.0.0" },
        peerDependencies: { typescript: ">=5.0.0" },
        optionalDependencies: { fsevents: "^2.3.0" },
      });

      vi.stubGlobal(
        "fetch",
        mockFetch({
          [packageJsonUrl()]: { status: 200, body: pkg },
          [lockUrl("package-lock.json")]: { status: 404 },
          [lockUrl("pnpm-lock.yaml")]: { status: 404 },
          [lockUrl("yarn.lock")]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.ecosystem).toBe("npm");
      expect(result.lock_file_present).toBe(false);

      const byName = Object.fromEntries(result.dependencies.map((d) => [d.package_name, d]));

      expect(byName.react).toMatchObject({
        package_name: "react",
        version_spec: "^18.0.0",
        dep_type: "production",
      });
      expect(byName.lodash).toMatchObject({
        dep_type: "production",
      });
      expect(byName.vitest).toMatchObject({
        dep_type: "development",
      });
      expect(byName.typescript).toMatchObject({
        dep_type: "peer",
      });
      expect(byName.fsevents).toMatchObject({
        dep_type: "optional",
      });

      expect(result.dependencies).toHaveLength(5);
    });

    it("handles scoped packages correctly", async () => {
      const pkg = JSON.stringify({
        dependencies: { "@deptend/core": "workspace:*", "@types/node": "^22.0.0" },
      });

      vi.stubGlobal(
        "fetch",
        mockFetch({
          [packageJsonUrl()]: { status: 200, body: pkg },
          [lockUrl("package-lock.json")]: { status: 404 },
          [lockUrl("pnpm-lock.yaml")]: { status: 404 },
          [lockUrl("yarn.lock")]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.dependencies).toHaveLength(2);
      expect(result.dependencies.map((d) => d.package_name)).toContain("@deptend/core");
      expect(result.dependencies.map((d) => d.package_name)).toContain("@types/node");
    });

    it("detects package-lock.json presence", async () => {
      const pkg = JSON.stringify({ dependencies: { express: "^4.0.0" } });

      vi.stubGlobal(
        "fetch",
        mockFetch({
          [packageJsonUrl()]: { status: 200, body: pkg },
          [lockUrl("package-lock.json")]: { status: 200 },
          [lockUrl("pnpm-lock.yaml")]: { status: 404 },
          [lockUrl("yarn.lock")]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.lock_file_present).toBe(true);
      // No lock file warning
      expect(result.warnings.some((w) => w.includes("No lock file"))).toBe(false);
    });

    it("detects pnpm-lock.yaml presence", async () => {
      const pkg = JSON.stringify({ dependencies: { express: "^4.0.0" } });

      vi.stubGlobal(
        "fetch",
        mockFetch({
          [packageJsonUrl()]: { status: 200, body: pkg },
          [lockUrl("package-lock.json")]: { status: 404 },
          [lockUrl("pnpm-lock.yaml")]: { status: 200 },
          [lockUrl("yarn.lock")]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);
      expect(result.lock_file_present).toBe(true);
    });

    it("tolerates a trailing slash in the base URL", async () => {
      const pkg = JSON.stringify({ dependencies: { chalk: "^5.0.0" } });

      vi.stubGlobal(
        "fetch",
        mockFetch({
          [packageJsonUrl()]: { status: 200, body: pkg },
          [lockUrl("package-lock.json")]: { status: 404 },
          [lockUrl("pnpm-lock.yaml")]: { status: 404 },
          [lockUrl("yarn.lock")]: { status: 404 },
        }),
      );

      // Trailing slash variant
      const result = await ingestor.parseDependencies(`${BASE}/`);
      expect(result.dependencies).toHaveLength(1);
    });

    it("returns no dependencies and a warning for an empty package.json", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [packageJsonUrl()]: { status: 200, body: JSON.stringify({}) },
          [lockUrl("package-lock.json")]: { status: 404 },
          [lockUrl("pnpm-lock.yaml")]: { status: 404 },
          [lockUrl("yarn.lock")]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.dependencies).toHaveLength(0);
      expect(result.manifest_resolved).toBe(true);
      expect(result.warnings.some((w) => w.includes("no dependency entries"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("parseDependencies — missing / malformed package.json", () => {
    it("returns empty result with warning when package.json is 404", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [packageJsonUrl()]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.dependencies).toHaveLength(0);
      expect(result.lock_file_present).toBe(false);
      expect(result.manifest_resolved).toBe(false);
      expect(result.warnings.some((w) => w.includes("No package.json"))).toBe(true);
    });

    it("throws on unexpected HTTP error fetching package.json", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [packageJsonUrl()]: { status: 500 },
        }),
      );

      await expect(ingestor.parseDependencies(BASE)).rejects.toThrow(/Unexpected HTTP 500/);
    });

    it("returns empty result with warning for invalid JSON", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [packageJsonUrl()]: { status: 200, body: "not json {{{" },
          [lockUrl("package-lock.json")]: { status: 404 },
          [lockUrl("pnpm-lock.yaml")]: { status: 404 },
          [lockUrl("yarn.lock")]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.dependencies).toHaveLength(0);
      expect(result.manifest_resolved).toBe(false);
      expect(result.warnings.some((w) => w.includes("not valid JSON"))).toBe(true);
    });

    it("returns empty result with warning when package.json root is an array", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          [packageJsonUrl()]: { status: 200, body: JSON.stringify([]) },
          [lockUrl("package-lock.json")]: { status: 404 },
          [lockUrl("pnpm-lock.yaml")]: { status: 404 },
          [lockUrl("yarn.lock")]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);
      expect(result.dependencies).toHaveLength(0);
      expect(result.manifest_resolved).toBe(false);
      expect(result.warnings.some((w) => w.includes("not a JSON object"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("parseDependencies — malformed dependency entries", () => {
    it("skips entries with empty version specs and warns", async () => {
      const pkg = JSON.stringify({
        dependencies: { valid: "^1.0.0", broken: "" },
      });

      vi.stubGlobal(
        "fetch",
        mockFetch({
          [packageJsonUrl()]: { status: 200, body: pkg },
          [lockUrl("package-lock.json")]: { status: 404 },
          [lockUrl("pnpm-lock.yaml")]: { status: 404 },
          [lockUrl("yarn.lock")]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0]?.package_name).toBe("valid");
      expect(result.warnings.some((w) => w.includes('"broken"'))).toBe(true);
    });

    it("skips invalid package names and warns", async () => {
      const pkg = JSON.stringify({
        dependencies: {
          "valid-pkg": "^1.0.0",
          INVALID_UPPERCASE: "^2.0.0",
          "": "^3.0.0",
        },
      });

      vi.stubGlobal(
        "fetch",
        mockFetch({
          [packageJsonUrl()]: { status: 200, body: pkg },
          [lockUrl("package-lock.json")]: { status: 404 },
          [lockUrl("pnpm-lock.yaml")]: { status: 404 },
          [lockUrl("yarn.lock")]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0]?.package_name).toBe("valid-pkg");
      expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    });

    it("warns and skips when a dependency section is not an object", async () => {
      const pkg = JSON.stringify({
        dependencies: { react: "^18.0.0" },
        devDependencies: "this-should-be-an-object",
      });

      vi.stubGlobal(
        "fetch",
        mockFetch({
          [packageJsonUrl()]: { status: 200, body: pkg },
          [lockUrl("package-lock.json")]: { status: 404 },
          [lockUrl("pnpm-lock.yaml")]: { status: 404 },
          [lockUrl("yarn.lock")]: { status: 404 },
        }),
      );

      const result = await ingestor.parseDependencies(BASE);

      // Only production dep parsed; devDependencies skipped with warning
      expect(result.dependencies).toHaveLength(1);
      expect(result.warnings.some((w) => w.includes('"devDependencies"'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("parseDependencies — network errors", () => {
    it("throws a descriptive error when fetch rejects (network failure)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      await expect(ingestor.parseDependencies(BASE)).rejects.toThrow(
        /Network error fetching package\.json/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // ADR 0041 — AbortSignal forwarding for parallel detectEcosystem() probing
  // -------------------------------------------------------------------------

  it("forwards a caller-supplied AbortSignal to the underlying fetch calls", async () => {
    // detectEcosystem() passes an AbortSignal to every probe so a higher-
    // priority probe winning the parallel race can cancel in-flight
    // lower-priority fetches. Verify the signal actually reaches fetch() —
    // i.e. NpmIngestor is plumbed through, not silently dropped.
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_input: string | URL, _init?: RequestInit): Response => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await ingestor.parseDependencies(BASE, controller.signal);

    // At least one fetch call was made with our signal attached.
    const callsWithSignal = fetchMock.mock.calls.filter(
      ([, init]) => init?.signal === controller.signal,
    );
    expect(callsWithSignal.length).toBeGreaterThan(0);
  });

  it("aborts an in-flight fetch when the caller's signal is already aborted", async () => {
    // The orchestrator fires controller.abort() once a higher-priority
    // probe wins. A still-pending fetch() should see the abort and
    // reject, not race the orchestrator's settle.
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit): Promise<Response> => {
      if (init?.signal?.aborted === true) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }
      // Realistic pending fetch — would only settle if no abort.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    controller.abort();
    await expect(ingestor.parseDependencies(BASE, controller.signal)).rejects.toThrow();
  });
});
