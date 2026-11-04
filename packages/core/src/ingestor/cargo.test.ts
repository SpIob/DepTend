/**
 * CargoIngestor unit tests
 *
 * Uses Vitest's built-in fetch mocking via vi.stubGlobal — same approach as
 * go.test.ts. Parsing edge cases live in cargo-parse.test.ts; these tests
 * focus on what's actually new here: fetching Cargo.toml, detecting
 * Cargo.lock remotely, and error handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CargoIngestor } from "./cargo.js";
import type { EcosystemIngestor } from "./interface.js";
import { BASE, lockUrl, mockFetch } from "./test-helpers.js";

function manifestUrl(base = BASE): string {
  return `${base}/Cargo.toml`;
}

const SIMPLE_CARGO_TOML = `[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1.0"\n`;

describe("CargoIngestor", () => {
  let ingestor: EcosystemIngestor;

  beforeEach(() => {
    // Transport backoff/deadline disabled — failure-path tests below stub a
    // rejecting fetch and must not sleep through the real 30 s policy.
    ingestor = new CargoIngestor({ retryDelayMs: 0, timeoutMs: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has the correct ecosystem property", () => {
    expect(ingestor.ecosystem).toBe("cargo");
  });

  it("fetches and parses Cargo.toml", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        [manifestUrl()]: { status: 200, body: SIMPLE_CARGO_TOML },
        [lockUrl("Cargo.lock")]: { status: 404 },
      }),
    );

    const result = await ingestor.parseDependencies(BASE);

    expect(result.ecosystem).toBe("cargo");
    expect(result.manifest_resolved).toBe(true);
    expect(result.dependencies).toEqual([
      { package_name: "serde", version_spec: "1.0", dep_type: "production" },
    ]);
  });

  it("tolerates a trailing slash in the base URL", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        [manifestUrl()]: { status: 200, body: SIMPLE_CARGO_TOML },
        [lockUrl("Cargo.lock")]: { status: 404 },
      }),
    );

    const result = await ingestor.parseDependencies(`${BASE}/`);
    expect(result.dependencies).toHaveLength(1);
  });

  it("detects Cargo.lock presence", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        [manifestUrl()]: { status: 200, body: SIMPLE_CARGO_TOML },
        [lockUrl("Cargo.lock")]: { status: 200 },
      }),
    );

    const result = await ingestor.parseDependencies(BASE);

    expect(result.lock_file_present).toBe(true);
    expect(result.warnings.some((w) => w.includes("No lock file"))).toBe(false);
  });

  it("reports lock_file_present: false with a warning when Cargo.lock is absent", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        [manifestUrl()]: { status: 200, body: SIMPLE_CARGO_TOML },
        [lockUrl("Cargo.lock")]: { status: 404 },
      }),
    );

    const result = await ingestor.parseDependencies(BASE);

    expect(result.lock_file_present).toBe(false);
    expect(result.warnings.some((w) => w.includes("No lock file detected"))).toBe(true);
  });

  it("returns empty result with warning when Cargo.toml is 404", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        [manifestUrl()]: { status: 404 },
      }),
    );

    const result = await ingestor.parseDependencies(BASE);

    expect(result.manifest_resolved).toBe(false);
    expect(result.dependencies).toEqual([]);
  });

  it("surfaces an unexpected HTTP status as a thrown error (probe failure path)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        [manifestUrl()]: { status: 500 },
      }),
    );

    await expect(ingestor.parseDependencies(BASE)).rejects.toThrow(/Unexpected HTTP 500/);
  });
});
