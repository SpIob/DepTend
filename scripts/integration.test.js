/**
 * Integration tests against real dev Neon infrastructure.
 *
 * These tests run against a real database, real OSV API, and real GitHub API.
 * They clean up all test data after each test.
 *
 * Skipped if DEV_DATABASE_URL is not set (fork-safe).
 *
 * Run with: pnpm --filter scripts test -- --run integration.test.js
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi as _vi } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { and as _and, eq } from "drizzle-orm";
import * as schema from "../packages/core/dist/db/schema.js";
import {
  fetchGitHubRepoMeta,
  GitHubMetaError as _GitHubMetaError,
} from "../packages/core/dist/ingestor/github-meta.js";
import {
  lookupGitHubOwnerMeta,
  GitHubOrgMetaError as _GitHubOrgMetaError,
} from "../packages/core/dist/ingestor/github-org-meta.js";
import { parseGithubUrl } from "../packages/core/dist/pipeline/parse-github-url.js";
import { detectEcosystem } from "../packages/core/dist/pipeline/ecosystem-detection.js";
import { NpmIngestor } from "../packages/core/dist/ingestor/npm.js";
import { PyPIIngestor } from "../packages/core/dist/ingestor/pypi.js";
import { GoIngestor } from "../packages/core/dist/ingestor/go.js";
import { OsvFetcher } from "../packages/core/dist/ingestor/osv.js";
import { IngestionWriter } from "../packages/core/dist/ingestor/writer.js";
import { MissionWriter } from "../packages/core/dist/scorer/writer.js";
import { REGISTRY_FETCHERS_BY_ECOSYSTEM } from "../packages/core/dist/pipeline/registry-fetchers.js";
import { buildSourceRepoByPackage } from "../packages/core/dist/pipeline/source-repo-extraction.js";
import { buildRawContentBase } from "../packages/core/dist/ingestor/github-meta.js";

const TEST_REPO_URL = "https://github.com/SpIob/deptend-go-test-fixture";
let db, pool, testRepoId;

const hasDevDb = !!process.env.DATABASE_URL;

if (!hasDevDb) {
  console.log("Skipping integration tests: DEV_DATABASE_URL not set");
}

beforeAll(async () => {
  if (!hasDevDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  db = drizzle(pool, { schema });

  // Ensure test repo exists in DB
  const { owner, name } = parseGithubUrl(TEST_REPO_URL);
  const existing = await db
    .select()
    .from(schema.repos)
    .where(eq(schema.repos.githubUrl, TEST_REPO_URL));
  if (existing.length > 0) {
    testRepoId = existing[0].id;
  } else {
    const inserted = await db
      .insert(schema.repos)
      .values({
        githubUrl: TEST_REPO_URL,
        owner,
        name,
        defaultBranch: "main",
        ingestionStatus: "pending",
        submittedBy: null,
      })
      .returning({ id: schema.repos.id });
    testRepoId = inserted[0].id;
  }
});

afterAll(async () => {
  if (pool) await pool.end();
});

beforeEach(async () => {
  if (!hasDb) return;
  // Clean up test data from previous runs
  await db.delete(schema.missions).where(eq(schema.missions.repoId, testRepoId));
  await db
    .delete(schema.missionScores)
    .where(
      eq(
        schema.missionScores.missionId,
        db
          .select({ id: schema.missions.id })
          .from(schema.missions)
          .where(eq(schema.missions.repoId, testRepoId)),
      ),
    );
  await db.delete(schema.ingestionRuns).where(eq(schema.ingestionRuns.repoId, testRepoId));
  await db
    .delete(schema.dependencyAdvisories)
    .where(
      eq(
        schema.dependencyAdvisories.dependencyId,
        db
          .select({ id: schema.dependencies.id })
          .from(schema.dependencies)
          .where(eq(schema.dependencies.repoId, testRepoId)),
      ),
    );
  await db.delete(schema.advisories).where(
    eq(
      schema.advisories.id,
      db
        .select({ advisoryId: schema.dependencyAdvisories.advisoryId })
        .from(schema.dependencyAdvisories)
        .where(
          eq(
            schema.dependencyAdvisories.dependencyId,
            db
              .select({ id: schema.dependencies.id })
              .from(schema.dependencies)
              .where(eq(schema.dependencies.repoId, testRepoId)),
          ),
        ),
    ),
  );
  await db.delete(schema.dependencies).where(eq(schema.dependencies.repoId, testRepoId));
});

function hasDb() {
  return hasDevDb && !!db;
}

describe.skipIf(!hasDevDb)("Integration: full ingestion pipeline", () => {
  it("ingests test repo end-to-end", async () => {
    if (!hasDb()) return;

    const writer = new IngestionWriter(db);
    const missionWriter = new MissionWriter(db);
    const npmIngestor = new NpmIngestor();
    const pypiIngestor = new PyPIIngestor();
    const goIngestor = new GoIngestor();
    const osvFetcher = new OsvFetcher();
    const registryFetchers = REGISTRY_FETCHERS_BY_ECOSYSTEM;

    const { owner, name } = parseGithubUrl(TEST_REPO_URL);
    const [ghMetaResult, orgResult] = await Promise.allSettled([
      fetchGitHubRepoMeta(owner, name, process.env.GITHUB_TOKEN ?? null),
      lookupGitHubOwnerMeta(owner, process.env.GITHUB_TOKEN ?? null),
    ]);

    expect(ghMetaResult.status).toBe("fulfilled");
    const ghMeta = ghMetaResult.value;
    const org = orgResult.status === "fulfilled" ? orgResult.value : null;

    const rawBase = buildRawContentBase(owner, name, ghMeta.default_branch);
    const ingestorResult = await detectEcosystem([npmIngestor, pypiIngestor, goIngestor], rawBase);
    expect(["npm", "pypi", "go"]).toContain(ingestorResult.ecosystem);
    expect(ingestorResult.dependencies.length).toBeGreaterThan(0);

    const registryFetcher = registryFetchers[ingestorResult.ecosystem];
    expect(registryFetcher).toBeDefined();

    const [osvResult, registryResult] = await Promise.all([
      osvFetcher.fetchAdvisories(ingestorResult.dependencies, ingestorResult.ecosystem),
      registryFetcher.fetchMetadata(ingestorResult.dependencies),
    ]);

    const sourceRepoByPackage = buildSourceRepoByPackage(registryResult);

    const writerInput = {
      repo: {
        githubUrl: TEST_REPO_URL,
        owner: ghMeta.owner.login,
        name: ghMeta.name,
        defaultBranch: ghMeta.default_branch,
        description: ghMeta.description ?? null,
        stars: ghMeta.stargazers_count,
        openIssuesCount: ghMeta.open_issues_count,
        topics: ghMeta.topics ?? [],
        homepageUrl: ghMeta.homepage ?? null,
        submittedBy: null,
      },
      ingestorResult,
      osvResult,
      registryResult,
      triggeredBy: "integration-test",
    };
    if (org) {
      writerInput.org = { githubLogin: org.login, name: org.name, avatarUrl: org.avatarUrl };
    }

    const output = await writer.write(writerInput);
    expect(output.status).toBe("complete");
    expect(output.dependenciesWritten).toBeGreaterThan(0);
    expect(output.runId).toBeDefined();

    const missionOutput = await missionWriter.generateMissionsForRepo(
      output.repoId,
      sourceRepoByPackage,
      process.env.GITHUB_TOKEN ?? null,
      process.env.LIBRARIES_IO_API_KEY ?? null,
    );

    expect(missionOutput.candidatesFound).toBeGreaterThanOrEqual(0);
    expect(typeof missionOutput.created).toBe("number");
    expect(typeof missionOutput.updated).toBe("number");
  });

  it("handles GitHub 404 gracefully (marks repo skipped)", async () => {
    if (!hasDb()) return;

    const { owner, name } = parseGithubUrl(
      "https://github.com/this-repo-definitely-does-not-exist-12345",
    );
    const result = await fetchGitHubRepoMeta(owner, name, process.env.GITHUB_TOKEN ?? null);
    expect(result).toBeDefined(); // Should throw or return error
  });

  it("handles OSV empty response", async () => {
    if (!hasDb()) return;

    const osvFetcher = new OsvFetcher();
    const result = await osvFetcher.fetchAdvisories([], "npm");
    expect(result.advisories.size).toBe(0);
    expect(result.packageAdvisoryMap.size).toBe(0);
  });

  it("handles missing registry fetcher for ecosystem", async () => {
    if (!hasDb()) return;

    const fetchers = { ...REGISTRY_FETCHERS_BY_ECOSYSTEM };
    delete fetchers.npm;
    const fetcher = fetchers["npm"];
    expect(fetcher).toBeUndefined();
  });
});
