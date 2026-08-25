/**
 * parsePackageJsonContent unit tests
 *
 * Calls the pure function directly with different raw content combinations
 * — no fetch/filesystem mocking needed, since parsing is deliberately
 * separated from I/O (see module docstring). Deliberately a dedicated test
 * file rather than only indirect coverage through NpmIngestor/LocalNpmIngestor
 * (what npm.test.ts covers) — the name/spec validation rules have enough
 * branches that testing the pure function directly is clearer than reaching
 * every case through mocked fetch calls, mirroring pypi-parse.test.ts and
 * go-parse.test.ts.
 */

import { describe, expect, it } from "vitest";
import { LOCK_FILE_NAMES, parsePackageJsonContent } from "./npm-parse.js";

const SOURCE = "https://raw.githubusercontent.com/owner/repo/main/package.json";

function parse(
  raw: string | null,
  lockFilePresent = true,
): ReturnType<typeof parsePackageJsonContent> {
  return parsePackageJsonContent(raw, lockFilePresent, SOURCE);
}

describe("parsePackageJsonContent", () => {
  describe("missing or unparseable manifest", () => {
    it("reports manifest_resolved: false when no package.json was found", () => {
      const result = parse(null);
      expect(result.manifest_resolved).toBe(false);
      expect(result.ecosystem).toBe("npm");
      expect(result.dependencies).toEqual([]);
      expect(result.warnings.some((w) => w.includes("No package.json"))).toBe(true);
      // The source location is surfaced so the warning says WHERE it looked
      expect(result.warnings.some((w) => w.includes(SOURCE))).toBe(true);
    });

    it("ignores lockFilePresent entirely when there is no manifest", () => {
      const result = parse(null, true);
      expect(result.manifest_resolved).toBe(false);
      expect(result.lock_file_present).toBe(false);
      expect(result.warnings.some((w) => w.includes("No lock file"))).toBe(false);
    });

    it("reports manifest_resolved: false for invalid JSON", () => {
      const result = parse("{not json");
      expect(result.manifest_resolved).toBe(false);
      expect(result.dependencies).toEqual([]);
      expect(result.warnings.some((w) => w.includes("not valid JSON"))).toBe(true);
    });

    it.each([
      ["[]", "an array root"],
      ["42", "a number root"],
      ['"just a string"', "a string root"],
      ["null", "a null root"],
    ])("reports manifest_resolved: false for %s", (raw) => {
      const result = parse(raw);
      expect(result.manifest_resolved).toBe(false);
      expect(result.dependencies).toEqual([]);
      expect(result.warnings.some((w) => w.includes("not a JSON object"))).toBe(true);
    });
  });

  describe("dependency sections", () => {
    it("maps each section to its dep_type", () => {
      const pkg = JSON.stringify({
        dependencies: { react: "^18.0.0" },
        devDependencies: { vitest: "^2.0.0" },
        peerDependencies: { typescript: ">=5.0.0" },
        optionalDependencies: { fsevents: "^2.3.0" },
      });

      const result = parse(pkg);

      expect(result.manifest_resolved).toBe(true);
      expect(result.dependencies).toEqual([
        { package_name: "react", version_spec: "^18.0.0", dep_type: "production" },
        { package_name: "vitest", version_spec: "^2.0.0", dep_type: "development" },
        { package_name: "typescript", version_spec: ">=5.0.0", dep_type: "peer" },
        { package_name: "fsevents", version_spec: "^2.3.0", dep_type: "optional" },
      ]);
    });

    it("trims whitespace from version specs", () => {
      const result = parse(JSON.stringify({ dependencies: { react: "  ^18.0.0  " } }));
      expect(result.dependencies).toEqual([
        { package_name: "react", version_spec: "^18.0.0", dep_type: "production" },
      ]);
    });

    it("accepts scoped package names", () => {
      const result = parse(
        JSON.stringify({
          dependencies: { "@deptend/core": "workspace:*", "@types/node": "^22.0.0" },
        }),
      );
      expect(result.dependencies.map((d) => d.package_name)).toEqual([
        "@deptend/core",
        "@types/node",
      ]);
    });

    it("skips entries with empty or whitespace-only version specs, with a warning", () => {
      const pkg = JSON.stringify({
        dependencies: { valid: "^1.0.0", empty: "", blank: "   " },
      });

      const result = parse(pkg);

      expect(result.dependencies).toEqual([
        { package_name: "valid", version_spec: "^1.0.0", dep_type: "production" },
      ]);
      expect(result.warnings.filter((w) => w.includes("version spec is missing"))).toHaveLength(2);
    });

    it("warns and skips a section that isn't an object, keeping the other sections", () => {
      const pkg = JSON.stringify({
        dependencies: { react: "^18.0.0" },
        devDependencies: "this-should-be-an-object",
      });

      const result = parse(pkg);

      expect(result.dependencies).toEqual([
        { package_name: "react", version_spec: "^18.0.0", dep_type: "production" },
      ]);
      expect(result.warnings.some((w) => w.includes('"devDependencies"'))).toBe(true);
      expect(result.manifest_resolved).toBe(true);
    });

    it("ignores non-dependency fields like scripts and name", () => {
      const pkg = JSON.stringify({
        name: "some-package",
        scripts: { test: "vitest" },
        dependencies: { react: "^18.0.0" },
      });

      const result = parse(pkg);

      expect(result.dependencies).toHaveLength(1);
    });
  });

  describe("package-name validation", () => {
    it.each([
      ["UPPERCASE", "uppercase letters"],
      [".leading-dot", "leading dot"],
      ["_leading-underscore", "leading underscore"],
      ["", "empty name"],
      ["@/", "scope-only name with no package part"],
      ["@scope/", "name with trailing slash after scope"],
      ["@", "bare @"],
      ["a".repeat(215), "name over the 214-char limit"],
      ["has space", "a space"],
      ["tilde~name", "a tilde"],
    ])('rejects "%s" (%s)', (name) => {
      const result = parse(JSON.stringify({ dependencies: { [name]: "^1.0.0" } }));
      expect(result.dependencies).toEqual([]);
      expect(result.warnings.some((w) => w.includes("Skipping invalid package name"))).toBe(true);
      expect(result.manifest_resolved).toBe(true);
    });

    it.each([
      ["a", "single character"],
      ["lodash", "plain lowercase"],
      ["lodash.merge", "internal dot"],
      ["lodash-core", "internal hyphen"],
      ["pkg_v2", "internal underscore"],
      ["a".repeat(214), "exactly 214 chars"],
      ["@scope/name", "well-formed scope"],
      ["@a1/b2", "digits in scope and name"],
    ])('accepts "%s" (%s)', (name) => {
      const result = parse(JSON.stringify({ dependencies: { [name]: "^1.0.0" } }));
      expect(result.dependencies.map((d) => d.package_name)).toEqual([name]);
      expect(result.warnings.some((w) => w.includes("Skipping invalid package name"))).toBe(false);
    });
  });

  describe("lock-file presence", () => {
    it("warns when no lock file is present", () => {
      const result = parse(JSON.stringify({ dependencies: { react: "^18.0.0" } }), false);
      expect(result.lock_file_present).toBe(false);
      expect(result.warnings.some((w) => w.includes("No lock file detected"))).toBe(true);
    });

    it("does not warn when a lock file is present", () => {
      const result = parse(JSON.stringify({ dependencies: { react: "^18.0.0" } }), true);
      expect(result.lock_file_present).toBe(true);
      expect(result.warnings.some((w) => w.includes("No lock file detected"))).toBe(false);
    });

    it("still warns about missing lock files alongside other warnings, not instead of them", () => {
      const result = parse(JSON.stringify({ dependencies: { BAD: "^1.0.0" } }), false);
      expect(result.lock_file_present).toBe(false);
      expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("zero-dependency manifests", () => {
    it("stays manifest_resolved: true but warns when there are no dependency entries", () => {
      const result = parse("{}");
      expect(result.manifest_resolved).toBe(true);
      expect(result.dependencies).toEqual([]);
      expect(result.warnings.some((w) => w.includes("no dependency entries"))).toBe(true);
    });
  });

  describe("LOCK_FILE_NAMES export", () => {
    it("covers the three known npm lock files", () => {
      expect([...LOCK_FILE_NAMES]).toEqual(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
    });
  });
});
