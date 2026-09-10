/**
 * runDetectStep unit tests
 *
 * Tests the ecosystem detection and dependency parsing step in isolation.
 * Uses real temp directories and the actual Local*Ingestor classes to
 * exercise the full detection logic without network calls.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { runDetectStep } from "./detect-step.js";
import {
  createTestRepo,
  writePackageJson,
  writePyProjectToml,
  writeRequirementsTxt,
  writeGoMod,
  writeGoSum,
  ManifestTemplates,
} from "../test/helpers/test-repo.js";

describe("runDetectStep", () => {
  let repo: Awaited<ReturnType<typeof createTestRepo>>;

  afterEach(async () => {
    if (repo) await repo.cleanup();
    vi.restoreAllMocks();
  });

  describe("npm detection", () => {
    it("detects npm when package.json exists", async () => {
      repo = await createTestRepo();
      await writePackageJson(repo.path, ManifestTemplates.npm.vulnerable);

      const result = await runDetectStep(repo.path);

      expect(result.ecosystem).toBe("npm");
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0]?.package_name).toBe("vulnerable-pkg");
      expect(result.dependencies[0]?.version_spec).toBe("^1.0.0");
      expect(result.dependencies[0]?.dep_type).toBe("production");
      expect(result.manifest_resolved).toBe(true);
      expect(result.lock_file_present).toBe(false);
    });

    it("detects npm with multiple dependencies", async () => {
      repo = await createTestRepo();
      await writePackageJson(repo.path, ManifestTemplates.npm.twoPackages);

      const result = await runDetectStep(repo.path);

      expect(result.ecosystem).toBe("npm");
      expect(result.dependencies).toHaveLength(2);
      const names = result.dependencies.map((d) => d.package_name).sort();
      expect(names).toEqual(["pkg-a", "pkg-b"]);
    });

    it("includes devDependencies when present", async () => {
      repo = await createTestRepo();
      await writePackageJson(repo.path, {
        dependencies: { "prod-pkg": "^1.0.0" },
        devDependencies: { "dev-pkg": "^2.0.0" },
      });

      const result = await runDetectStep(repo.path);

      expect(result.dependencies).toHaveLength(2);
      const types = result.dependencies.map((d) => d.dep_type).sort();
      expect(types).toEqual(["development", "production"]);
    });

    it("detects lock file presence", async () => {
      repo = await createTestRepo();
      await writePackageJson(repo.path, ManifestTemplates.npm.vulnerable);
      // Write a package-lock.json
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await writeFile(
        join(repo.path, "package-lock.json"),
        JSON.stringify(
          {
            name: "test",
            version: "1.0.0",
            lockfileVersion: 2,
            requires: true,
            packages: { "": { dependencies: { "vulnerable-pkg": "^1.0.0" } } },
          },
          null,
          2,
        ),
      );

      const result = await runDetectStep(repo.path);

      expect(result.lock_file_present).toBe(true);
    });

    it("returns warnings for malformed package.json", async () => {
      repo = await createTestRepo();
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await writeFile(join(repo.path, "package.json"), "{ invalid json");

      const result = await runDetectStep(repo.path);

      // npm probe runs first and fails, but since it's the first in order,
      // its warning is included. Other probes also run and fail.
      expect(result.ecosystem).toBe("npm"); // Still tries npm first (first in array)
      expect(
        result.warnings.some((w) => w.includes("not valid JSON") || w.includes("npm probe failed")),
      ).toBe(true);
    });
  });

  describe("PyPI detection", () => {
    it("falls back to PyPI when only pyproject.toml exists", async () => {
      repo = await createTestRepo();
      await writePyProjectToml(repo.path, ManifestTemplates.pypi.vulnerable);

      const result = await runDetectStep(repo.path);

      expect(result.ecosystem).toBe("pypi");
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0]?.package_name).toBe("vulnerable-pkg");
      expect(result.dependencies[0]?.version_spec).toBe(">=1.0.0");
      expect(result.manifest_resolved).toBe(true);
    });

    it("falls back to PyPI when only requirements.txt exists", async () => {
      repo = await createTestRepo();
      await writeRequirementsTxt(repo.path, "vulnerable-pkg>=1.0.0\n");

      const result = await runDetectStep(repo.path);

      expect(result.ecosystem).toBe("pypi");
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0]?.package_name).toBe("vulnerable-pkg");
    });

    it("prefers npm when both package.json and pyproject.toml exist", async () => {
      repo = await createTestRepo();
      await writePackageJson(repo.path, ManifestTemplates.npm.clean);
      await writePyProjectToml(repo.path, ManifestTemplates.pypi.vulnerable);

      const result = await runDetectStep(repo.path);

      expect(result.ecosystem).toBe("npm");
      expect(result.dependencies[0]?.package_name).toBe("clean-pkg");
    });
  });

  describe("Go detection", () => {
    it("falls back to Go when only go.mod exists", async () => {
      repo = await createTestRepo();
      await writeGoMod(repo.path, ManifestTemplates.go.vulnerable);

      const result = await runDetectStep(repo.path);

      expect(result.ecosystem).toBe("go");
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0]?.package_name).toBe("github.com/vulnerable/pkg");
      expect(result.dependencies[0]?.version_spec).toBe("v1.0.0");
      expect(result.manifest_resolved).toBe(true);
    });

    it("detects go.sum as lock file", async () => {
      repo = await createTestRepo();
      await writeGoMod(repo.path, ManifestTemplates.go.vulnerable);
      await writeGoSum(repo.path, "github.com/vulnerable/pkg v1.0.0 h1:abc123\n");

      const result = await runDetectStep(repo.path);

      expect(result.lock_file_present).toBe(true);
    });

    it("prefers PyPI over Go when both pyproject.toml and go.mod exist", async () => {
      repo = await createTestRepo();
      await writePyProjectToml(repo.path, ManifestTemplates.pypi.clean);
      await writeGoMod(repo.path, ManifestTemplates.go.vulnerable);

      const result = await runDetectStep(repo.path);

      expect(result.ecosystem).toBe("pypi");
    });
  });

  describe("no manifest found", () => {
    it("returns empty dependencies and warnings from all ingestors", async () => {
      repo = await createTestRepo();
      // Empty directory - no manifest files

      const result = await runDetectStep(repo.path);

      expect(result.dependencies).toHaveLength(0);
      // When all probes fail, returns one of the attempt results
      // (order depends on parallel settlement timing)
      expect(["npm", "pypi", "go"]).toContain(result.ecosystem);
      expect(result.manifest_resolved).toBe(false);
      expect(result.warnings.length).toBeGreaterThanOrEqual(3); // npm + PyPI + Go warnings
      expect(result.warnings.some((w) => w.includes("No package.json found"))).toBe(true);
      expect(result.warnings.some((w) => w.includes("No usable pyproject.toml"))).toBe(true);
    });
  });

  describe("nested manifests", () => {
    it("does NOT find package.json in subdirectory (only root searched)", async () => {
      repo = await createTestRepo();
      const { mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const subdir = join(repo.path, "subdir");
      await mkdir(subdir, { recursive: true });
      await writePackageJson(subdir, ManifestTemplates.npm.vulnerable);

      const result = await runDetectStep(repo.path);

      // Local ingestors only search the root directory
      // All probes fail (no manifests at root), so ecosystem depends on settlement order
      expect(["npm", "pypi", "go"]).toContain(result.ecosystem);
      expect(result.dependencies).toHaveLength(0);
    });
  });
});
