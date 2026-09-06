/**
 * Shared fetch router for CLI tests.
 *
 * Provides a configurable fetch mock that routes requests to canned responses
 * based on URL patterns. Each test can override specific responses while
 * falling back to shared defaults.
 */

import { vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");

export interface FixtureMap {
  githubMeta: string;
  osvBatch: string;
  osvBatchMultiple: string;
  osvBatchPypi: string;
  osvBatchGo: string;
  osvDetails: Record<string, string>;
  npmRegistry: string;
  pypiRegistry: string;
  goRegistry: string;
}

/**
 * Loads all fixture files into memory.
 */
async function loadFixtures(): Promise<FixtureMap> {
  const [githubMeta, osvBatch, osvDetail, npmRegistry, pypiRegistry, goRegistry] =
    await Promise.all([
      readFile(join(FIXTURES_DIR, "github-meta.json"), "utf-8"),
      readFile(join(FIXTURES_DIR, "osv-batch-response.json"), "utf-8"),
      readFile(join(FIXTURES_DIR, "osv-detail-response.json"), "utf-8"),
      readFile(join(FIXTURES_DIR, "npm-registry-response.json"), "utf-8"),
      readFile(join(FIXTURES_DIR, "pypi-registry-response.json"), "utf-8"),
      readFile(join(FIXTURES_DIR, "go-registry-response.json"), "utf-8"),
    ]);

  // Load optional batch variants with fallbacks
  const [osvBatchMultiple, osvBatchPypi, osvBatchGo] = await Promise.all([
    readFile(join(FIXTURES_DIR, "osv-batch-multiple.json"), "utf-8").catch(() => osvBatch),
    readFile(join(FIXTURES_DIR, "osv-batch-pypi.json"), "utf-8").catch(() => osvBatch),
    readFile(join(FIXTURES_DIR, "osv-batch-go.json"), "utf-8").catch(() => osvBatch),
  ]);

  const osvDetails: Record<string, string> = {
    "GHSA-test-1234": osvDetail,
  };

  // Load additional OSV detail fixtures
  const detailFiles = [
    "osv-detail-older.json",
    "osv-detail-newer.json",
    "osv-detail-pypi.json",
    "osv-detail-go.json",
  ];
  for (const file of detailFiles) {
    const id = file.replace("osv-detail-", "").replace(".json", "");
    try {
      osvDetails[id] = await readFile(join(FIXTURES_DIR, file), "utf-8");
    } catch {
      // optional fixtures
    }
  }

  return {
    githubMeta: githubMeta.trim(),
    osvBatch: osvBatch.trim(),
    osvBatchMultiple: osvBatchMultiple.trim(),
    osvBatchPypi: osvBatchPypi.trim(),
    osvBatchGo: osvBatchGo.trim(),
    osvDetails,
    npmRegistry: npmRegistry.trim(),
    pypiRegistry: pypiRegistry.trim(),
    goRegistry: goRegistry.trim(),
  };
}

let cachedFixtures: FixtureMap | null = null;

export async function getFixtures(): Promise<FixtureMap> {
  if (!cachedFixtures) {
    cachedFixtures = await loadFixtures();
  }
  return cachedFixtures;
}

export interface FetchRouteOptions {
  /** Override the default GitHub meta response */
  githubMeta?: object;
  /** Override the default OSV batch response */
  osvBatch?: object;
  /** Add or override OSV detail responses by ID */
  osvDetails?: Record<string, object>;
  /** Override the default npm registry response */
  npmRegistry?: object;
  /** Override the default PyPI registry response */
  pypiRegistry?: object;
  /** Override the default Go registry response */
  goRegistry?: object;
  /** Override GitHub releases response (for breaking-change signals) */
  githubReleases?: object;
}

/**
 * Creates a fetch implementation that routes to canned responses.
 *
 * @param options - Optional overrides for specific responses
 * @returns A fetch function suitable for vi.stubGlobal("fetch", ...)
 */
export async function createFetchRouter(options: FetchRouteOptions = {}): Promise<typeof fetch> {
  const fixtures = await getFixtures();

  // Merge overrides with defaults
  const githubMeta = options.githubMeta ?? JSON.parse(fixtures.githubMeta);
  const osvBatch = options.osvBatch ?? JSON.parse(fixtures.osvBatch);
  const osvDetails = {
    ...fixtures.osvDetails,
    ...Object.fromEntries(
      Object.entries(options.osvDetails ?? {}).map(([k, v]) => [k, JSON.stringify(v)]),
    ),
  };
  const npmRegistry = options.npmRegistry ?? JSON.parse(fixtures.npmRegistry);
  const pypiRegistry = options.pypiRegistry ?? JSON.parse(fixtures.pypiRegistry);
  const goRegistry = options.goRegistry ?? JSON.parse(fixtures.goRegistry);
  const githubReleases = options.githubReleases ?? { json: () => Promise.resolve([]) };

  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // GitHub repo metadata
    if (url.includes("api.github.com/repos/") && !url.includes("/releases")) {
      return new Response(JSON.stringify(githubMeta), { status: 200 });
    }

    // GitHub releases (for breaking-change signals)
    if (url.includes("api.github.com/repos/") && url.includes("/releases")) {
      const body =
        typeof githubReleases === "function" ? await githubReleases(url) : githubReleases;
      return new Response(JSON.stringify(body), { status: 200 });
    }

    // OSV batch query
    if (url.includes("api.osv.dev/v1/querybatch")) {
      return new Response(JSON.stringify(osvBatch), { status: 200 });
    }

    // OSV detail fetch
    if (url.includes("api.osv.dev/v1/vulns/")) {
      const osvId = url.split("/vulns/")[1]?.split("/")[0]?.split("?")[0];
      if (osvId && osvDetails[osvId]) {
        return new Response(osvDetails[osvId], { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }

    // npm registry
    if (url.includes("registry.npmjs.org/")) {
      return new Response(JSON.stringify(npmRegistry), { status: 200 });
    }

    // PyPI registry
    if (url.includes("pypi.org/pypi/")) {
      return new Response(JSON.stringify(pypiRegistry), { status: 200 });
    }

    // Go module proxy
    if (url.includes("proxy.golang.org/")) {
      return new Response(JSON.stringify(goRegistry), { status: 200 });
    }

    throw new Error(`Unmocked fetch call in test: ${url}`);
  });
}

/**
 * Creates a fetch router configured for a basic npm vulnerability test.
 */
export async function createNpmFetchRouter(): Promise<typeof fetch> {
  return createFetchRouter();
}

/**
 * Creates a fetch router configured for a PyPI vulnerability test.
 */
export async function createPyPIFetchRouter(): Promise<typeof fetch> {
  const fixtures = await getFixtures();
  return createFetchRouter({
    osvBatch: JSON.parse(fixtures.osvBatchPypi),
    osvDetails: {
      "GHSA-test-pypi-1234": JSON.parse(
        await readFile(join(FIXTURES_DIR, "osv-detail-pypi.json"), "utf-8"),
      ),
    },
    pypiRegistry: JSON.parse(fixtures.pypiRegistry),
  });
}

/**
 * Creates a fetch router configured for a Go vulnerability test.
 */
export async function createGoFetchRouter(): Promise<typeof fetch> {
  const fixtures = await getFixtures();
  return createFetchRouter({
    osvBatch: JSON.parse(fixtures.osvBatchGo),
    osvDetails: {
      "GHSA-test-go-1234": JSON.parse(
        await readFile(join(FIXTURES_DIR, "osv-detail-go.json"), "utf-8"),
      ),
    },
    goRegistry: JSON.parse(fixtures.goRegistry),
  });
}

/**
 * Creates a fetch router for the tie-breaking test (two advisories).
 */
export async function createTieBreakingFetchRouter(): Promise<typeof fetch> {
  const fixtures = await getFixtures();
  return createFetchRouter({
    osvBatch: JSON.parse(fixtures.osvBatchMultiple),
    osvDetails: {
      "GHSA-older-1111": JSON.parse(
        await readFile(join(FIXTURES_DIR, "osv-detail-older.json"), "utf-8"),
      ),
      "GHSA-newer-2222": JSON.parse(
        await readFile(join(FIXTURES_DIR, "osv-detail-newer.json"), "utf-8"),
      ),
    },
  });
}

/**
 * Creates a fetch router for the breaking-change signals test (ADR 0029).
 */
export async function createBreakingChangeFetchRouter(): Promise<typeof fetch> {
  await getFixtures(); // ensure fixtures are loaded
  return createFetchRouter({
    osvDetails: {
      "GHSA-test-1234": JSON.parse(
        await readFile(join(FIXTURES_DIR, "osv-detail-response.json"), "utf-8"),
      ),
    },
    githubReleases: (url: string) => {
      const isFirstPage = url.includes("&page=1");
      return isFirstPage
        ? [
            {
              tag_name: "v1.0.1",
              body: "BREAKING CHANGE: removed the deprecated foo() export.",
              prerelease: false,
              draft: false,
            },
          ]
        : [];
    },
    npmRegistry: {
      version: "1.0.1",
      repository: "vulnerable-org/vulnerable-pkg",
    },
  });
}
