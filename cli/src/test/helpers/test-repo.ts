/**
 * Test repo helpers for creating temporary repo directories with manifests.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestRepo {
  path: string;
  cleanup: () => Promise<void>;
}

/**
 * Creates a temporary directory for a test repo.
 * The directory is automatically cleaned up when the returned cleanup function is called.
 */
export async function createTestRepo(): Promise<TestRepo> {
  const path = await mkdtemp(join(tmpdir(), "deptend-test-"));
  return {
    path,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/**
 * Writes a package.json file to the repo directory.
 */
export async function writePackageJson(repoPath: string, content: object): Promise<void> {
  await writeFile(join(repoPath, "package.json"), JSON.stringify(content, null, 2));
}

/**
 * Writes a pyproject.toml file to the repo directory.
 */
export async function writePyProjectToml(repoPath: string, content: string): Promise<void> {
  await writeFile(join(repoPath, "pyproject.toml"), content);
}

/**
 * Writes a requirements.txt file to the repo directory.
 */
export async function writeRequirementsTxt(repoPath: string, content: string): Promise<void> {
  await writeFile(join(repoPath, "requirements.txt"), content);
}

/**
 * Writes a go.mod file to the repo directory.
 */
export async function writeGoMod(repoPath: string, content: string): Promise<void> {
  await writeFile(join(repoPath, "go.mod"), content);
}

/**
 * Writes a go.sum file to the repo directory.
 */
export async function writeGoSum(repoPath: string, content: string): Promise<void> {
  await writeFile(join(repoPath, "go.sum"), content);
}

/**
 * Common manifest templates for test scenarios.
 */
export const ManifestTemplates = {
  npm: {
    vulnerable: { dependencies: { "vulnerable-pkg": "^1.0.0" } },
    clean: { dependencies: { "clean-pkg": "^1.0.0" } },
    twoPackages: { dependencies: { "pkg-a": "^1.0.0", "pkg-b": "^1.0.0" } },
  },
  pypi: {
    vulnerable: `[project]\ndependencies = ["vulnerable-pkg>=1.0.0"]\n`,
    clean: `[project]\ndependencies = ["clean-pkg>=1.0.0"]\n`,
  },
  go: {
    vulnerable:
      "module github.com/owner/repo\n\ngo 1.21\n\nrequire github.com/vulnerable/pkg v1.0.0\n",
    clean: "module github.com/owner/repo\n\ngo 1.21\n",
  },
};

/**
 * Sets up a test repo with the given manifest template.
 * Returns the repo path.
 */
type NpmTemplate = keyof typeof ManifestTemplates.npm;
type PypiTemplate = keyof typeof ManifestTemplates.pypi;
type GoTemplate = keyof typeof ManifestTemplates.go;

export async function setupTestRepo(type: "npm", template: NpmTemplate): Promise<TestRepo>;
export async function setupTestRepo(type: "pypi", template: PypiTemplate): Promise<TestRepo>;
export async function setupTestRepo(type: "go", template: GoTemplate): Promise<TestRepo>;
export async function setupTestRepo(
  type: "npm" | "pypi" | "go",
  template: NpmTemplate | PypiTemplate | GoTemplate,
): Promise<TestRepo> {
  const repo = await createTestRepo();
  const templates = ManifestTemplates[type];
  if (!templates) {
    throw new Error(`Unknown repo type: ${type}`);
  }
  const content = templates[template as keyof typeof templates];
  if (!content) {
    throw new Error(`Unknown template: ${template}`);
  }

  if (type === "npm") {
    await writePackageJson(repo.path, content as object);
  } else if (type === "pypi") {
    await writePyProjectToml(repo.path, content as string);
  } else if (type === "go") {
    await writeGoMod(repo.path, content as string);
  }

  return repo;
}
