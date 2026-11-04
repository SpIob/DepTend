/**
 * Cargo.toml parsing unit tests (ADR 0063, Decision 2)
 *
 * Pure parsing — no network, no filesystem. Mirrors go-parse.test.ts's
 * structure: the three dependency tables, the three value shapes,
 * workspace inheritance, dep_type mapping, and every unresolved path.
 */

import { describe, expect, it } from "vitest";
import { isValidCrateName, parseCargoTomlContent } from "./cargo-parse.js";

const SOURCE = "https://raw.githubusercontent.com/owner/repo/main/Cargo.toml";

describe("parseCargoTomlContent", () => {
  it("returns manifest_resolved: false with a warning for null content", () => {
    const result = parseCargoTomlContent(null, false, SOURCE);

    expect(result.ecosystem).toBe("cargo");
    expect(result.manifest_resolved).toBe(false);
    expect(result.dependencies).toEqual([]);
    expect(result.warnings.some((w) => w.includes("No Cargo.toml found at"))).toBe(true);
  });

  it("returns manifest_resolved: false for invalid TOML", () => {
    const result = parseCargoTomlContent("not [valid toml\n===", false, SOURCE);

    expect(result.manifest_resolved).toBe(false);
    expect(result.warnings.some((w) => w.includes("not valid TOML"))).toBe(true);
  });

  it("parses the three standard dependency tables with correct dep_types", () => {
    const raw = `
[dependencies]
serde = "1.0"

[dev-dependencies]
tempfile = "3.10"

[build-dependencies]
cc = "1.0"
`;
    const result = parseCargoTomlContent(raw, false, SOURCE);

    expect(result.manifest_resolved).toBe(true);
    expect(result.dependencies).toEqual([
      { package_name: "serde", version_spec: "1.0", dep_type: "production" },
      { package_name: "tempfile", version_spec: "3.10", dep_type: "development" },
      { package_name: "cc", version_spec: "1.0", dep_type: "production" },
    ]);
  });

  it("handles the inline-table value shape with optional = true", () => {
    const raw = `
[dependencies]
serde = { version = "1.0", features = ["derive"] }
crypto = { version = "0.1", optional = true }
`;
    const result = parseCargoTomlContent(raw, false, SOURCE);

    expect(result.dependencies).toEqual([
      { package_name: "serde", version_spec: "1.0", dep_type: "production" },
      { package_name: "crypto", version_spec: "0.1", dep_type: "optional" },
    ]);
  });

  it("resolves workspace-inherited deps against [workspace.dependencies] in the same file", () => {
    const raw = `
[dependencies]
serde = { workspace = true }

[workspace.dependencies]
serde = "1.0"
`;
    const result = parseCargoTomlContent(raw, false, SOURCE);

    expect(result.dependencies).toEqual([
      { package_name: "serde", version_spec: "1.0", dep_type: "production" },
    ]);
  });

  it("falls back to version_spec '*' with a warning when a workspace dep has no workspace version", () => {
    const raw = `
[dependencies]
serde = { workspace = true }
`;
    const result = parseCargoTomlContent(raw, false, SOURCE);

    expect(result.dependencies).toEqual([
      { package_name: "serde", version_spec: "*", dep_type: "production" },
    ]);
    expect(
      result.warnings.some((w) => w.includes("workspace-inherited but no workspace version")),
    ).toBe(true);
  });

  it("records '*' for git/path dependencies with no version requirement", () => {
    const raw = `
[dependencies]
local-crate = { path = "../local-crate" }
git-crate = { git = "https://github.com/foo/bar" }
`;
    const result = parseCargoTomlContent(raw, false, SOURCE);

    expect(result.dependencies).toEqual([
      { package_name: "local-crate", version_spec: "*", dep_type: "production" },
      { package_name: "git-crate", version_spec: "*", dep_type: "production" },
    ]);
  });

  it("warns and skips entries with no version and no source key", () => {
    const raw = `
[dependencies]
mystery = { features = ["derive"] }
serde = "1.0"
`;
    const result = parseCargoTomlContent(raw, false, SOURCE);

    expect(result.dependencies).toEqual([
      { package_name: "serde", version_spec: "1.0", dep_type: "production" },
    ]);
    expect(result.warnings.some((w) => w.includes("no version requirement found"))).toBe(true);
  });

  it("skips invalid crate names with a warning", () => {
    // Quoted keys so TOML keeps them as literal dependency keys rather
    // than interpreting `has.dot` as a nested-table path.
    const raw = `
[dependencies]
valid-crate = "1.0"
"has.dot" = "1.0"
"---" = "1.0"
`;
    const result = parseCargoTomlContent(raw, false, SOURCE);

    expect(result.dependencies).toEqual([
      { package_name: "valid-crate", version_spec: "1.0", dep_type: "production" },
    ]);
    expect(result.warnings.filter((w) => w.includes("Skipping invalid crate name"))).toHaveLength(
      2,
    );
  });

  it("leaves [target] and [patch] tables inert", () => {
    const raw = `
[dependencies]
serde = "1.0"

[target.'cfg(unix)'.dependencies]
nix = "0.29"

[patch.crates-io]
serde = { git = "https://github.com/serde-rs/serde" }
`;
    const result = parseCargoTomlContent(raw, false, SOURCE);

    expect(result.dependencies).toEqual([
      { package_name: "serde", version_spec: "1.0", dep_type: "production" },
    ]);
  });

  it("treats a virtual workspace root with no dependency tables as resolved with zero deps", () => {
    const raw = `
[workspace]
members = ["crate-a", "crate-b"]
resolver = "2"
`;
    const result = parseCargoTomlContent(raw, false, SOURCE);

    expect(result.manifest_resolved).toBe(true);
    expect(result.dependencies).toEqual([]);
    expect(result.warnings.some((w) => w.includes("no dependency entries"))).toBe(true);
  });

  it("warns about a missing lock file but stays resolved", () => {
    const raw = `[dependencies]\nserde = "1.0"\n`;
    const result = parseCargoTomlContent(raw, false, SOURCE);

    expect(result.manifest_resolved).toBe(true);
    expect(result.lock_file_present).toBe(false);
    expect(result.warnings.some((w) => w.includes("No lock file detected (Cargo.lock)"))).toBe(
      true,
    );
  });

  it("merges Cargo.lock content: resolved versions + transitive packages", () => {
    const manifest = `[dependencies]\nserde = "1.0"\n`;
    const lock = `
version = 3

[[package]]
name = "serde"
version = "1.0.219"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "serde_core"
version = "1.0.219"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;
    const result = parseCargoTomlContent(manifest, true, SOURCE, lock, "Cargo.lock");

    expect(result.lock_file_present).toBe(true);
    expect(result.lock_file_parsed).toBe(true);
    expect(result.lock_file_format).toBe("Cargo.lock");

    const direct = result.dependencies.find((d) => d.package_name === "serde");
    expect(direct?.resolved_version).toBe("1.0.219");
    expect(direct?.is_transitive).toBe(false);

    const transitive = result.dependencies.find((d) => d.package_name === "serde_core");
    expect(transitive?.dep_type).toBe("transitive");
    expect(transitive?.is_transitive).toBe(true);
    expect(transitive?.resolved_version).toBe("1.0.219");
  });

  it("falls back to manifest-only when the lock file is unparseable", () => {
    const manifest = `[dependencies]\nserde = "1.0"\n`;
    const result = parseCargoTomlContent(manifest, true, SOURCE, "not [valid", "Cargo.lock");

    expect(result.lock_file_present).toBe(true);
    expect(result.lock_file_parsed).toBeUndefined();
    expect(result.dependencies).toEqual([
      { package_name: "serde", version_spec: "1.0", dep_type: "production" },
    ]);
  });
});

describe("isValidCrateName", () => {
  it("accepts crates.io-conforming names", () => {
    expect(isValidCrateName("serde")).toBe(true);
    expect(isValidCrateName("tokio-util")).toBe(true);
    expect(isValidCrateName("serde_core")).toBe(true);
    expect(isValidCrateName("Foo")).toBe(true);
  });

  it("rejects non-conforming names", () => {
    expect(isValidCrateName("")).toBe(false);
    expect(isValidCrateName("has.dot")).toBe(false);
    expect(isValidCrateName("has space")).toBe(false);
    expect(isValidCrateName("---")).toBe(false);
    expect(isValidCrateName("___")).toBe(false);
    expect(isValidCrateName("a".repeat(65))).toBe(false);
  });
});
