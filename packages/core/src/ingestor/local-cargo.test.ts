/**
 * LocalCargoIngestor unit tests
 *
 * Uses real temporary directories on disk (via node:fs/promises' mkdtemp)
 * rather than mocking node:fs — same rationale local-go.test.ts documents:
 * fs behavior (ENOENT vs. EISDIR, actual file presence) is more faithfully
 * exercised against the real filesystem.
 *
 * Parsing edge cases live in cargo-parse.test.ts; these tests focus on
 * reading from disk and detecting Cargo.lock locally.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalCargoIngestor } from "./local-cargo.js";
import type { EcosystemIngestor } from "./interface.js";

let repoDir: string;
let ingestor: EcosystemIngestor;

const SIMPLE_CARGO_TOML = `[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1.0"\n`;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "deptend-local-cargo-"));
  ingestor = new LocalCargoIngestor();
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("LocalCargoIngestor", () => {
  it("has the correct ecosystem property", () => {
    expect(ingestor.ecosystem).toBe("cargo");
  });

  it("parses dependencies from a real Cargo.toml on disk", async () => {
    await writeFile(join(repoDir, "Cargo.toml"), SIMPLE_CARGO_TOML);

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.ecosystem).toBe("cargo");
    expect(result.dependencies).toEqual([
      { package_name: "serde", version_spec: "1.0", dep_type: "production" },
    ]);
  });

  it("detects and parses Cargo.lock as the lock file", async () => {
    await writeFile(join(repoDir, "Cargo.toml"), SIMPLE_CARGO_TOML);
    await writeFile(
      join(repoDir, "Cargo.lock"),
      `[[package]]\nname = "serde"\nversion = "1.0.219"\n`,
    );

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.lock_file_present).toBe(true);
    expect(result.lock_file_parsed).toBe(true);
    expect(result.lock_file_format).toBe("Cargo.lock");
    expect(result.warnings).not.toContainEqual(expect.stringContaining("No lock file detected"));
  });

  it("reports lock_file_present: false and a warning when Cargo.lock doesn't exist", async () => {
    await writeFile(join(repoDir, "Cargo.toml"), SIMPLE_CARGO_TOML);

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.lock_file_present).toBe(false);
    expect(result.warnings).toContainEqual(expect.stringContaining("No lock file detected"));
  });

  it("returns an empty result with a warning when Cargo.toml doesn't exist", async () => {
    const result = await ingestor.parseDependencies(repoDir);

    expect(result.dependencies).toEqual([]);
    expect(result.lock_file_present).toBe(false);
    expect(result.manifest_resolved).toBe(false);
    expect(result.warnings).toContainEqual(expect.stringContaining("No Cargo.toml found at"));
  });

  it("does not report lock_file_present when Cargo.toml is missing, even if Cargo.lock exists", async () => {
    // Cargo.toml intentionally absent
    await writeFile(join(repoDir, "Cargo.lock"), "");

    const result = await ingestor.parseDependencies(repoDir);

    expect(result.lock_file_present).toBe(false);
  });

  it("throws a descriptive error for a filesystem error other than ENOENT", async () => {
    // A directory named Cargo.toml triggers EISDIR on read, not ENOENT —
    // same portable trick local-go.test.ts uses.
    await mkdir(join(repoDir, "Cargo.toml"));

    await expect(ingestor.parseDependencies(repoDir)).rejects.toThrow(/Failed to read/);
  });
});
