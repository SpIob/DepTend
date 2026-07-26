/**
 * parseGoModContent unit tests
 *
 * Calls the pure function directly with different raw go.mod content — no
 * fetch/filesystem mocking needed, since parsing is deliberately separated
 * from I/O (see module docstring). Dedicated test file, same convention
 * pypi-parse.test.ts established in Phase 6 (rather than only indirect
 * coverage through GoIngestor/LocalGoIngestor, npm.test.ts's older
 * convention) — go.mod's block/single-line/indirect-comment rules have
 * enough branches to warrant testing the pure function directly. Ingestor-
 * level tests (Step 2) still cover the fetch/read wiring itself.
 *
 * Several fixtures below are drawn from real go.mod files (gorilla/mux,
 * spf13/cobra, gin-gonic/gin), fetched directly during ADR 0024's own
 * grounding — not invented shapes.
 */

import { describe, expect, it } from "vitest";
import { parseGoModContent } from "./go-parse.js";

const SOURCE = "https://raw.githubusercontent.com/owner/repo/main/go.mod";

function parse(raw: string | null, lockFilePresent = true): ReturnType<typeof parseGoModContent> {
  return parseGoModContent(raw, lockFilePresent, SOURCE);
}

describe("parseGoModContent", () => {
  describe("go.mod not found", () => {
    it("reports manifest_resolved: false and no dependencies", () => {
      const result = parse(null);
      expect(result.manifest_resolved).toBe(false);
      expect(result.dependencies).toEqual([]);
      expect(result.ecosystem).toBe("go");
      expect(result.lock_file_present).toBe(false);
      expect(result.warnings.some((w) => w.includes("Repository skipped"))).toBe(true);
    });
  });

  describe("malformed go.mod (no module directive)", () => {
    it("reports manifest_resolved: false when there's no recognizable module directive", () => {
      const result = parse("this is not a go.mod file at all\njust some text\n");
      expect(result.manifest_resolved).toBe(false);
      expect(result.dependencies).toEqual([]);
      expect(result.warnings.some((w) => w.includes('No "module" directive found'))).toBe(true);
    });
  });

  describe("genuinely empty go.mod (real gorilla/mux shape)", () => {
    it("resolves with zero dependencies, not skipped", () => {
      const goMod = `module github.com/gorilla/mux\n\ngo 1.20\n`;
      const result = parse(goMod);
      expect(result.manifest_resolved).toBe(true);
      expect(result.dependencies).toEqual([]);
      expect(result.warnings.some((w) => w.includes("no direct require entries"))).toBe(true);
    });

    it("tolerates a bare 'module' line with no trailing path", () => {
      // Not realistic for a real go.mod but exercises the `trimmed === "module"`
      // branch independently of `trimmed.startsWith("module ")`.
      const result = parse("module\n\ngo 1.20\n");
      expect(result.manifest_resolved).toBe(true);
    });
  });

  describe("grouped require block (real spf13/cobra shape)", () => {
    it("parses every entry as a production dependency", () => {
      const goMod = `module github.com/spf13/cobra

go 1.15

require (
\tgithub.com/cpuguy83/go-md2man/v2 v2.0.6
\tgithub.com/inconshreveable/mousetrap v1.1.0
\tgithub.com/spf13/pflag v1.0.9
\tgo.yaml.in/yaml/v3 v3.0.4
)
`;
      const result = parse(goMod);
      expect(result.manifest_resolved).toBe(true);
      expect(result.dependencies).toEqual([
        {
          package_name: "github.com/cpuguy83/go-md2man/v2",
          version_spec: "v2.0.6",
          dep_type: "production",
        },
        {
          package_name: "github.com/inconshreveable/mousetrap",
          version_spec: "v1.1.0",
          dep_type: "production",
        },
        { package_name: "github.com/spf13/pflag", version_spec: "v1.0.9", dep_type: "production" },
        { package_name: "go.yaml.in/yaml/v3", version_spec: "v3.0.4", dep_type: "production" },
      ]);
    });
  });

  describe("multiple require blocks + mixed direct/indirect (real gin-gonic/gin shape)", () => {
    it("excludes // indirect entries from both grouped and single-line requires, across multiple blocks", () => {
      const goMod = `module github.com/gin-gonic/gin

go 1.25.0

require (
\tgithub.com/bytedance/sonic v1.15.0
\tgithub.com/gin-contrib/sse v1.1.0
)

require gopkg.in/yaml.v3 v3.0.1 // indirect

require (
\tgithub.com/bytedance/gopkg v0.1.3 // indirect
\tgithub.com/klauspost/cpuid/v2 v2.3.0 // indirect
)
`;
      const result = parse(goMod);
      expect(result.dependencies).toEqual([
        {
          package_name: "github.com/bytedance/sonic",
          version_spec: "v1.15.0",
          dep_type: "production",
        },
        {
          package_name: "github.com/gin-contrib/sse",
          version_spec: "v1.1.0",
          dep_type: "production",
        },
      ]);
      // Indirect entries are silently excluded, not warned about.
      expect(result.warnings.some((w) => w.toLowerCase().includes("indirect"))).toBe(false);
    });

    it("reports 'no direct require entries' when every require is indirect", () => {
      const goMod = `module example.com/allindirect

go 1.22

require (
\tgithub.com/foo/bar v1.0.0 // indirect
\tgithub.com/baz/qux v2.0.0 // indirect
)
`;
      const result = parse(goMod);
      expect(result.manifest_resolved).toBe(true);
      expect(result.dependencies).toEqual([]);
      expect(result.warnings.some((w) => w.includes("no direct require entries"))).toBe(true);
    });
  });

  describe("single-line require directive", () => {
    it("parses a bare 'require <module> <version>' line outside any block", () => {
      const goMod = `module example.com/single\n\ngo 1.22\n\nrequire github.com/pkg/errors v0.9.1\n`;
      const result = parse(goMod);
      expect(result.dependencies).toEqual([
        { package_name: "github.com/pkg/errors", version_spec: "v0.9.1", dep_type: "production" },
      ]);
    });
  });

  describe("module paths and versions", () => {
    it("treats a major-version-suffixed module path as an opaque package name", () => {
      const goMod = `module example.com/x\n\ngo 1.22\n\nrequire (\n\tgithub.com/foo/bar/v2 v2.3.1\n)\n`;
      const result = parse(goMod);
      expect(result.dependencies).toEqual([
        { package_name: "github.com/foo/bar/v2", version_spec: "v2.3.1", dep_type: "production" },
      ]);
    });

    it("passes a pseudo-version through verbatim, unvalidated", () => {
      const goMod = `module example.com/x\n\ngo 1.22\n\nrequire (\n\tgithub.com/foo/bar v0.0.0-20210101000000-abcdef123456\n)\n`;
      const result = parse(goMod);
      expect(result.dependencies).toEqual([
        {
          package_name: "github.com/foo/bar",
          version_spec: "v0.0.0-20210101000000-abcdef123456",
          dep_type: "production",
        },
      ]);
    });

    it("allows mixed-case module paths (e.g. github.com/Masterminds/semver)", () => {
      const goMod = `module example.com/x\n\ngo 1.22\n\nrequire (\n\tgithub.com/Masterminds/semver/v3 v3.2.1\n)\n`;
      const result = parse(goMod);
      expect(result.dependencies).toEqual([
        {
          package_name: "github.com/Masterminds/semver/v3",
          version_spec: "v3.2.1",
          dep_type: "production",
        },
      ]);
    });

    it("skips a require entry missing a version, with a warning", () => {
      const goMod = `module example.com/x\n\ngo 1.22\n\nrequire (\n\tgithub.com/foo/bar\n)\n`;
      const result = parse(goMod);
      expect(result.dependencies).toEqual([]);
      expect(result.warnings.some((w) => w.includes("unparseable require entry"))).toBe(true);
    });

    it("skips an entry with a quoted module path, with a warning", () => {
      const goMod = `module example.com/x\n\ngo 1.22\n\nrequire (\n\t"weird module" v1.0.0\n)\n`;
      const result = parse(goMod);
      expect(result.dependencies).toEqual([]);
      expect(result.warnings.some((w) => w.includes("invalid module path"))).toBe(true);
    });
  });

  describe("non-require directives are inert", () => {
    it("ignores replace directives without contaminating parsed dependencies", () => {
      const goMod = `module example.com/x

go 1.22

require (
\tgithub.com/foo/bar v1.0.0
)

replace github.com/foo/bar => github.com/foo/bar-fork v1.0.1

replace (
\tgithub.com/baz/qux => ../local-qux
)
`;
      const result = parse(goMod);
      expect(result.dependencies).toEqual([
        { package_name: "github.com/foo/bar", version_spec: "v1.0.0", dep_type: "production" },
      ]);
    });

    it("ignores toolchain and exclude directives", () => {
      const goMod = `module example.com/x

go 1.22

toolchain go1.22.3

exclude github.com/bad/pkg v1.0.0

require (
\tgithub.com/foo/bar v1.0.0
)
`;
      const result = parse(goMod);
      expect(result.dependencies).toEqual([
        { package_name: "github.com/foo/bar", version_spec: "v1.0.0", dep_type: "production" },
      ]);
    });

    it("tolerates full-line and trailing comments (not just // indirect)", () => {
      const goMod = `module example.com/x

go 1.22

require (
\t// this is a comment line
\tgithub.com/foo/bar v1.0.0 // pinned for a reason, not indirect
)
`;
      const result = parse(goMod);
      expect(result.dependencies).toEqual([
        { package_name: "github.com/foo/bar", version_spec: "v1.0.0", dep_type: "production" },
      ]);
    });
  });

  describe("malformed require block", () => {
    it("does not crash on an unterminated require( block and keeps what it parsed", () => {
      const goMod = `module example.com/x\n\ngo 1.22\n\nrequire (\n\tgithub.com/foo/bar v1.0.0\n`; // no closing paren
      expect(() => parse(goMod)).not.toThrow();
      const result = parse(goMod);
      expect(result.dependencies).toEqual([
        { package_name: "github.com/foo/bar", version_spec: "v1.0.0", dep_type: "production" },
      ]);
    });
  });

  describe("lock file presence", () => {
    it("warns when go.sum is not detected", () => {
      const goMod = `module example.com/x\n\ngo 1.22\n\nrequire (\n\tgithub.com/foo/bar v1.0.0\n)\n`;
      const result = parse(goMod, false);
      expect(result.lock_file_present).toBe(false);
      expect(result.warnings.some((w) => w.includes("go.sum"))).toBe(true);
    });

    it("does not warn when go.sum is detected", () => {
      const goMod = `module example.com/x\n\ngo 1.22\n\nrequire (\n\tgithub.com/foo/bar v1.0.0\n)\n`;
      const result = parse(goMod, true);
      expect(result.lock_file_present).toBe(true);
      expect(result.warnings.some((w) => w.includes("go.sum"))).toBe(false);
    });

    it("ignores lockFilePresent when go.mod itself is missing", () => {
      const result = parse(null, true);
      expect(result.lock_file_present).toBe(false);
    });

    it("ignores lockFilePresent when go.mod has no module directive", () => {
      const result = parse("not a go.mod\n", true);
      expect(result.lock_file_present).toBe(false);
    });
  });

  describe("blank lines and whitespace", () => {
    it("tolerates blank lines and tab indentation throughout", () => {
      const goMod = `module example.com/x\n\n\ngo 1.22\n\n\nrequire (\n\n\tgithub.com/foo/bar v1.0.0\n\n)\n\n`;
      const result = parse(goMod);
      expect(result.dependencies).toEqual([
        { package_name: "github.com/foo/bar", version_spec: "v1.0.0", dep_type: "production" },
      ]);
    });
  });
});
