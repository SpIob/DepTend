/**
 * parsePyPIManifests unit tests
 *
 * Calls the pure function directly with different raw content combinations
 * — no fetch/filesystem mocking needed, since parsing is deliberately
 * separated from I/O (see module docstring). Deliberately a dedicated test
 * file rather than only indirect coverage through PyPIIngestor/
 * LocalPyPIIngestor (the convention npm.test.ts follows for
 * parsePackageJsonContent) — the pyproject.toml/requirements.txt fallback
 * rule has enough branches that testing the pure function directly is
 * clearer than reaching every case through mocked fetch calls. Ingestor-
 * level tests (Step 3) still cover the fetch/read wiring itself.
 */

import { describe, expect, it } from "vitest";
import { parsePyPIManifests } from "./pypi-parse.js";

const PYPROJECT_SOURCE = "https://raw.githubusercontent.com/owner/repo/main/pyproject.toml";
const REQUIREMENTS_SOURCE = "https://raw.githubusercontent.com/owner/repo/main/requirements.txt";

function parse(
  pyprojectRaw: string | null,
  requirementsRaw: string | null,
  lockFilePresent = true,
): ReturnType<typeof parsePyPIManifests> {
  return parsePyPIManifests(
    pyprojectRaw,
    requirementsRaw,
    lockFilePresent,
    PYPROJECT_SOURCE,
    REQUIREMENTS_SOURCE,
  );
}

describe("parsePyPIManifests", () => {
  describe("neither manifest present", () => {
    it("reports manifest_resolved: false and no dependencies", () => {
      const result = parse(null, null);
      expect(result.manifest_resolved).toBe(false);
      expect(result.dependencies).toEqual([]);
      expect(result.ecosystem).toBe("pypi");
      expect(result.warnings.some((w) => w.includes("Repository skipped"))).toBe(true);
    });
  });

  describe("pyproject.toml, PEP 621", () => {
    it("parses [project.dependencies] as production deps", () => {
      const toml = `
[project]
name = "myapp"
dependencies = ["requests>=2.25,<3", "click~=8.0"]
`;
      const result = parse(toml, null);
      expect(result.manifest_resolved).toBe(true);
      expect(result.dependencies).toEqual([
        { package_name: "requests", version_spec: ">=2.25,<3", dep_type: "production" },
        { package_name: "click", version_spec: "~=8.0", dep_type: "production" },
      ]);
    });

    it("parses [project.optional-dependencies] extras as optional deps", () => {
      const toml = `
[project]
name = "myapp"
dependencies = ["requests>=2.25"]

[project.optional-dependencies]
dev = ["pytest>=7.0", "black"]
docs = ["sphinx"]
`;
      const result = parse(toml, null);
      expect(result.dependencies).toContainEqual({
        package_name: "pytest",
        version_spec: ">=7.0",
        dep_type: "optional",
      });
      expect(result.dependencies).toContainEqual({
        package_name: "black",
        version_spec: "*",
        dep_type: "optional",
      });
      expect(result.dependencies).toContainEqual({
        package_name: "sphinx",
        version_spec: "*",
        dep_type: "optional",
      });
    });

    it("strips extras brackets without folding them into package_name", () => {
      const toml = `
[project]
dependencies = ["requests[security,socks]>=2.25"]
`;
      const result = parse(toml, null);
      expect(result.dependencies).toEqual([
        { package_name: "requests", version_spec: ">=2.25", dep_type: "production" },
      ]);
    });

    it("strips environment markers and discards them", () => {
      const toml = `
[project]
dependencies = ["click>=8.0; python_version >= \\"3.8\\""]
`;
      const result = parse(toml, null);
      expect(result.dependencies).toEqual([
        { package_name: "click", version_spec: ">=8.0", dep_type: "production" },
      ]);
    });

    it("treats an unconstrained dependency as version_spec '*'", () => {
      const toml = `
[project]
dependencies = ["requests"]
`;
      const result = parse(toml, null);
      expect(result.dependencies).toEqual([
        { package_name: "requests", version_spec: "*", dep_type: "production" },
      ]);
    });

    it("captures a PEP 508 direct URL reference as version_spec verbatim", () => {
      const toml = `
[project]
dependencies = ["mypkg @ https://example.com/mypkg-1.0-py3-none-any.whl"]
`;
      const result = parse(toml, null);
      expect(result.dependencies).toEqual([
        {
          package_name: "mypkg",
          version_spec: "https://example.com/mypkg-1.0-py3-none-any.whl",
          dep_type: "production",
        },
      ]);
    });

    it("does NOT consult requirements.txt when [project.dependencies] is explicitly empty", () => {
      const toml = `
[project]
dependencies = []
`;
      const result = parse(toml, "requests==2.0.0");
      expect(result.manifest_resolved).toBe(true);
      expect(result.dependencies).toEqual([]);
      expect(result.warnings.some((w) => w.includes("no dependency entries"))).toBe(true);
      // requirements.txt was never touched — no requirements-sourced warning present
      expect(result.warnings.some((w) => w.includes(REQUIREMENTS_SOURCE))).toBe(false);
    });

    it("skips an invalid package name with a warning but keeps the rest", () => {
      const toml = `
[project]
dependencies = ["_bad-leading-underscore>=1.0", "requests>=2.25"]
`;
      const result = parse(toml, null);
      expect(result.dependencies).toEqual([
        { package_name: "requests", version_spec: ">=2.25", dep_type: "production" },
      ]);
      expect(result.warnings.some((w) => w.includes("Skipping invalid package name"))).toBe(true);
    });

    it("skips a malformed project.dependencies value but stays resolved (not a fallback trigger)", () => {
      const toml = `
[project]
dependencies = "not-an-array"
`;
      const result = parse(toml, "requests==2.0.0");
      expect(result.manifest_resolved).toBe(true);
      expect(result.dependencies).toEqual([]);
      expect(result.warnings.some((w) => w.includes("is not an array"))).toBe(true);
      // A malformed-but-present "dependencies" key is a valid PEP 621 file
      // with a data problem, not a "wrong tool" signal — no fallback.
      expect(result.warnings.some((w) => w.includes(REQUIREMENTS_SOURCE))).toBe(false);
    });
  });

  describe("pyproject.toml fallback triggers", () => {
    it("falls back to requirements.txt when pyproject.toml is invalid TOML", () => {
      const badToml = "this is not [ valid toml";
      const result = parse(badToml, "requests==2.31.0");
      expect(result.manifest_resolved).toBe(true);
      expect(result.dependencies).toEqual([
        { package_name: "requests", version_spec: "==2.31.0", dep_type: "production" },
      ]);
      expect(result.warnings.some((w) => w.includes("not valid TOML"))).toBe(true);
    });

    it("falls back to requirements.txt when pyproject.toml has no [project] table", () => {
      const poetryStyle = `
[tool.poetry]
name = "myapp"
[tool.poetry.dependencies]
requests = "^2.25"
`;
      const result = parse(poetryStyle, "click==8.1.0");
      expect(result.manifest_resolved).toBe(true);
      expect(result.dependencies).toEqual([
        { package_name: "click", version_spec: "==8.1.0", dep_type: "production" },
      ]);
      expect(result.warnings.some((w) => w.includes("no [project] table"))).toBe(true);
    });

    it("falls back to requirements.txt when [project] exists but has no dependencies key", () => {
      const noDepsKey = `
[project]
name = "myapp"
`;
      const result = parse(noDepsKey, "click==8.1.0");
      expect(result.manifest_resolved).toBe(true);
      expect(result.dependencies).toEqual([
        { package_name: "click", version_spec: "==8.1.0", dep_type: "production" },
      ]);
      expect(result.warnings.some((w) => w.includes('no "dependencies" key'))).toBe(true);
    });

    it("is skipped when pyproject.toml is missing entirely and requirements.txt resolves", () => {
      const result = parse(null, "requests>=2.0");
      expect(result.manifest_resolved).toBe(true);
      expect(result.dependencies).toEqual([
        { package_name: "requests", version_spec: ">=2.0", dep_type: "production" },
      ]);
    });

    it("is skipped when both pyproject.toml and requirements.txt fail to resolve", () => {
      const result = parse("not valid [ toml", null);
      expect(result.manifest_resolved).toBe(false);
      expect(result.dependencies).toEqual([]);
    });
  });

  describe("requirements.txt", () => {
    it("parses plain name==version / name>=version lines", () => {
      const reqs = "requests==2.31.0\nclick>=8.0,<9.0\n";
      const result = parse(null, reqs);
      expect(result.dependencies).toEqual([
        { package_name: "requests", version_spec: "==2.31.0", dep_type: "production" },
        { package_name: "click", version_spec: ">=8.0,<9.0", dep_type: "production" },
      ]);
    });

    it("silently skips blank lines and full-line comments", () => {
      const reqs = "\nrequests==2.31.0\n# a comment\n\n  \nclick>=8.0\n";
      const result = parse(null, reqs);
      expect(result.dependencies).toHaveLength(2);
      expect(result.warnings.some((w) => w.includes("comment"))).toBe(false);
    });

    it("strips a trailing inline comment", () => {
      const reqs = "requests==2.31.0  # pinned for API compat\n";
      const result = parse(null, reqs);
      expect(result.dependencies).toEqual([
        { package_name: "requests", version_spec: "==2.31.0", dep_type: "production" },
      ]);
    });

    it("skips pragma lines (-r, -e, --hash) with a warning, not as packages", () => {
      const reqs = [
        "-r base-requirements.txt",
        "-e git+https://example.com/pkg.git#egg=pkg",
        "--hash=sha256:abc123",
        "requests==2.31.0",
      ].join("\n");
      const result = parse(null, reqs);
      expect(result.dependencies).toEqual([
        { package_name: "requests", version_spec: "==2.31.0", dep_type: "production" },
      ]);
      expect(result.warnings.filter((w) => w.includes("Skipping unsupported"))).toHaveLength(3);
    });

    it("treats every entry as dep_type production (no dev/optional distinction)", () => {
      const result = parse(null, "pytest>=7.0");
      expect(result.dependencies).toEqual([
        { package_name: "pytest", version_spec: ">=7.0", dep_type: "production" },
      ]);
    });

    it("reports no dependency entries when the file is entirely comments/blank", () => {
      const result = parse(null, "# nothing here\n\n");
      expect(result.manifest_resolved).toBe(true);
      expect(result.dependencies).toEqual([]);
      expect(result.warnings.some((w) => w.includes("no dependency entries"))).toBe(true);
    });
  });

  describe("lock file presence", () => {
    it("warns when no lock file is present", () => {
      const result = parse("[project]\ndependencies = []\n", null, false);
      expect(result.lock_file_present).toBe(false);
      expect(result.warnings.some((w) => w.includes("No lock file detected"))).toBe(true);
    });

    it("does not warn when a lock file is present", () => {
      const result = parse("[project]\ndependencies = []\n", null, true);
      expect(result.lock_file_present).toBe(true);
      expect(result.warnings.some((w) => w.includes("No lock file detected"))).toBe(false);
    });

    it("ignores lockFilePresent when nothing resolves", () => {
      const result = parse(null, null, true);
      expect(result.lock_file_present).toBe(false);
    });
  });
});
