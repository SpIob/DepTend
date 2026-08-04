#!/usr/bin/env node
/**
 * scripts/ingest.js
 *
 * Data ingestion job entry point. Runs in GitHub Actions on a daily cron
 * schedule or on manual trigger via workflow_dispatch.
 *
 * Usage:
 *   node scripts/ingest.js --triggered-by cron
 *   node scripts/ingest.js --triggered-by manual --repo-id <uuid>
 *   node scripts/ingest.js --triggered-by manual --repo-url https://github.com/owner/name
 *
 * Arguments:
 *   --triggered-by  cron | manual (default: cron)
 *   --repo-id       UUID of a specific repo already in the DB (optional)
 *   --repo-url      Full GitHub URL — convenience for local testing; upserts
 *                   the repo if not already present (optional)
 *
 * Environment variables:
 *   DATABASE_URL    Required. Pooled Neon connection string (PgBouncer).
 *   GITHUB_TOKEN    Optional but strongly recommended. Raises the GitHub API
 *                   rate limit from 60 to 5,000 requests/hour.
 *
 * Exit codes:
 *   0  All targeted repos processed successfully (warnings are non-fatal).
 *   1  One or more repos failed, or a fatal startup error occurred.
 *
 * Phase 1: ingests repos, dependencies, and advisories.
 * Phase 2: also generates/refreshes vulnerability_fix missions and scores
 * for every is_affected dependency, immediately after a repo's ingestion
 * write succeeds (see MissionWriter, packages/core/src/scorer/writer.ts).
 * Phase 6 (ADR 0022): a repo's ecosystem is no longer assumed to be npm —
 * detected per-repo via ordered probing (detectEcosystem: npm first, then
 * PyPI), with no schema field recording the choice — it's re-decided fresh
 * on every run from what's actually in the repo, not stored as a fact
 * about the repo itself.
 * Phase 7 (ADR 0024): Go added as a third probed ecosystem (npm, then
 * PyPI, then Go) — same router, same "not stored" design, no changes to
 * either.
 * ADR 0029 (Step 5): missionWriter.generateMissionsForRepo() now also
 * receives sourceRepoByPackage — built straight from registryResult's
 * already-fetched sourceRepo field, not a second registry round trip —
 * so it can prefetch each candidate dependency's own breaking-change
 * signals before its DB transaction opens.
 */

import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq, or } from "drizzle-orm";

// Internal imports via direct dist paths — the scripts/ directory is an
// internal monorepo consumer; it bypasses the @deptend/core exports map
// intentionally to access ingestor modules not part of the public surface.
import * as schema from "../packages/core/dist/db/schema.js";
import { NpmIngestor } from "../packages/core/dist/ingestor/npm.js";
import { PyPIIngestor } from "../packages/core/dist/ingestor/pypi.js";
import { GoIngestor } from "../packages/core/dist/ingestor/go.js";
import { detectEcosystem } from "../packages/core/dist/ingestor/detect.js";
import { OsvFetcher } from "../packages/core/dist/ingestor/osv.js";
import { NpmRegistryFetcher } from "../packages/core/dist/ingestor/registry.js";
import { PyPIRegistryFetcher } from "../packages/core/dist/ingestor/pypi-registry.js";
import { GoRegistryFetcher } from "../packages/core/dist/ingestor/go-registry.js";
import { IngestionWriter } from "../packages/core/dist/ingestor/writer.js";
import { MissionWriter } from "../packages/core/dist/scorer/writer.js";
import { fetchGitHubRepoMeta } from "../packages/core/dist/ingestor/github-meta.js";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  log("info", `Starting ingestion`, {
    triggeredBy: args.triggeredBy,
    repoId: args.repoId ?? null,
    repoUrl: args.repoUrl ?? null,
  });

  // ------------------------------------------------------------------
  // Validate environment
  // ------------------------------------------------------------------
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    fatal("DATABASE_URL environment variable is not set.");
  }

  const githubToken = process.env["GITHUB_TOKEN"];
  if (!githubToken) {
    log(
      "warn",
      "GITHUB_TOKEN is not set. GitHub API calls will be unauthenticated " +
        "(60 req/hr limit). Set GITHUB_TOKEN to raise the limit to 5,000 req/hr.",
    );
  }

  // ------------------------------------------------------------------
  // Initialise DB client
  // ------------------------------------------------------------------
  // neon-serverless (WebSocket) driver — required for real transaction
  // support; the neon-http driver cannot run db.transaction() at all
  // (ADR 0009). Native Node WebSocket support (Node 22+) means no `ws`
  // package is needed here; this project runs Node 24/26.
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  const writer = new IngestionWriter(db);
  const missionWriter = new MissionWriter(db);

  // ------------------------------------------------------------------
  // Resolve which repos to process
  // ------------------------------------------------------------------
  let targetRepos;

  if (args.repoUrl) {
    // --repo-url: convenience for local testing — doesn't require the repo
    // to already be in the database.
    targetRepos = await resolveByUrl(db, args.repoUrl);
  } else if (args.repoId) {
    // --repo-id: process one specific repo by UUID.
    targetRepos = await resolveById(db, args.repoId);
  } else {
    // Cron / no filter: process all repos with status 'pending' or 'failed'.
    targetRepos = await resolvePending(db);
  }

  if (targetRepos.length === 0) {
    log("info", "No repos to process. Exiting.");
    await pool.end();
    process.exit(0);
  }

  log("info", `Processing ${targetRepos.length} repo(s).`);

  // ------------------------------------------------------------------
  // Run the pipeline for each repo
  // ------------------------------------------------------------------
  // Three of each — the router (below, per-repo) probes npm first, then
  // PyPI, then Go (ADR 0024), and the matching registry fetcher is picked
  // once the winning ecosystem is known via REGISTRY_FETCHERS_BY_ECOSYSTEM
  // below. All three ingestor/fetcher pairs are stateless and safely
  // reused across every repo in this run, same as the original single npm
  // pair was before Phase 6.
  const npmIngestor = new NpmIngestor();
  const pypiIngestor = new PyPIIngestor();
  const goIngestor = new GoIngestor();
  const osvFetcher = new OsvFetcher();
  // Keyed by Ecosystem value, not a chain of ternaries — a future
  // ecosystem missing an entry here fails loudly (see the lookup in
  // ingestRepo below), not silently via a wrong fall-through. JS has no
  // compile-time exhaustiveness check the way osv.ts's
  // Record<Ecosystem, ...> maps get from TypeScript, so the runtime guard
  // at the lookup site is this file's equivalent safety net.
  const registryFetchersByEcosystem = {
    npm: new NpmRegistryFetcher(),
    pypi: new PyPIRegistryFetcher(),
    go: new GoRegistryFetcher(),
  };

  let failCount = 0;

  // try/finally guarantees pool.end() runs even if something above the
  // per-repo try/catch inside ingestRepo somehow still throws — a Pool
  // holds an open WebSocket that must be closed explicitly, unlike the
  // stateless neon-http client this used to be (ADR 0009).
  try {
    for (const repo of targetRepos) {
      const success = await ingestRepo(
        repo,
        db,
        writer,
        missionWriter,
        npmIngestor,
        pypiIngestor,
        goIngestor,
        osvFetcher,
        registryFetchersByEcosystem,
        githubToken ?? null,
        args.triggeredBy,
      );
      if (!success) failCount++;
    }
  } finally {
    await pool.end();
  }

  if (failCount > 0) {
    log("error", `${failCount} of ${targetRepos.length} repo(s) failed.`);
    process.exit(1);
  }

  log("info", `All ${targetRepos.length} repo(s) ingested successfully.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Per-repo pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full ingestion pipeline for a single repo.
 * Returns true on success, false on failure (errors are logged, not thrown).
 */
async function ingestRepo(
  repo,
  db,
  writer,
  missionWriter,
  npmIngestor,
  pypiIngestor,
  goIngestor,
  osvFetcher,
  registryFetchersByEcosystem,
  githubToken,
  triggeredBy,
) {
  const label = repo.githubUrl ?? repo.url;
  log("info", `[${label}] Starting ingestion`);

  try {
    // 1. Fetch current repo metadata from GitHub
    const { owner, name } = parseGithubUrl(repo.githubUrl ?? repo.url);
    const ghMeta = await fetchGitHubRepoMeta(owner, name, githubToken);

    const repoInput = {
      githubUrl: `https://github.com/${ghMeta.full_name}`,
      owner: ghMeta.owner.login,
      name: ghMeta.name,
      defaultBranch: ghMeta.default_branch,
      description: ghMeta.description ?? null,
      stars: ghMeta.stargazers_count,
      openIssuesCount: ghMeta.open_issues_count,
      topics: ghMeta.topics ?? [],
      homepageUrl: ghMeta.homepage ?? null,
      submittedBy: repo.submittedBy ?? null,
    };

    // 2. Build the raw content base URL for the ingestors
    const rawBase = `https://raw.githubusercontent.com/${owner}/${name}/${repoInput.defaultBranch}`;

    // 3. Detect ecosystem + parse dependencies. Ordered probing (ADR
    // 0022, extended in ADR 0024): npm first, then PyPI, then Go.
    log("info", `[${label}] Detecting ecosystem and parsing dependencies`);
    const ingestorResult = await detectEcosystem([npmIngestor, pypiIngestor, goIngestor], rawBase);
    logWarnings(label, ingestorResult.warnings);

    log(
      "info",
      `[${label}] Ecosystem: ${ingestorResult.ecosystem} — found ${ingestorResult.dependencies.length} dependencies` +
        ` (lock_file_present=${ingestorResult.lock_file_present})`,
    );

    // 4. Fetch OSV advisories
    log("info", `[${label}] Querying OSV for advisories`);
    const osvResult = await osvFetcher.fetchAdvisories(
      ingestorResult.dependencies,
      ingestorResult.ecosystem,
    );
    logWarnings(label, osvResult.warnings);

    log(
      "info",
      `[${label}] Found ${osvResult.advisories.size} unique advisory/ies` +
        ` across ${osvResult.packageAdvisoryMap.size} package(s)`,
    );

    // 5. Fetch registry metadata — matching fetcher for whichever
    // ecosystem actually resolved. Map lookup, not a ternary — a future
    // ecosystem missing an entry fails loudly here rather than silently
    // reusing npm's fetcher for the wrong registry.
    const registryFetcher = registryFetchersByEcosystem[ingestorResult.ecosystem];
    if (!registryFetcher) {
      throw new Error(
        `No registry fetcher configured for ecosystem "${ingestorResult.ecosystem}".`,
      );
    }
    log("info", `[${label}] Fetching ${ingestorResult.ecosystem} registry metadata`);
    const registryResult = await registryFetcher.fetchMetadata(ingestorResult.dependencies);
    logWarnings(label, registryResult.warnings);

    const deprecatedCount = [...registryResult.metadata.values()].filter(
      (m) => m.isDeprecated,
    ).length;
    log("info", `[${label}] ${deprecatedCount} deprecated package(s) detected`);

    // ADR 0029, Step 5: no second registry round trip — sourceRepo was
    // already resolved (best-effort) as part of the fetchMetadata() call
    // above, from data that call already received.
    const sourceRepoByPackage = new Map(
      [...registryResult.metadata.entries()].map(([packageName, meta]) => [
        packageName,
        meta.sourceRepo,
      ]),
    );
    const resolvedSourceRepoCount = [...sourceRepoByPackage.values()].filter(
      (ref) => ref !== null,
    ).length;
    log(
      "info",
      `[${label}] Resolved a GitHub source repo for ${resolvedSourceRepoCount} of ` +
        `${sourceRepoByPackage.size} package(s)`,
    );

    // 6. Write to database
    log("info", `[${label}] Writing to database`);
    const output = await writer.write({
      repo: repoInput,
      ingestorResult,
      osvResult,
      registryResult,
      triggeredBy,
    });

    log("info", `[${label}] Done`, {
      repoId: output.repoId,
      runId: output.runId,
      status: output.status,
      dependenciesWritten: output.dependenciesWritten,
      advisoriesWritten: output.advisoriesWritten,
      dependencyAdvisoriesWritten: output.dependencyAdvisoriesWritten,
      warnings: output.allWarnings.length,
    });

    // 7. Generate/refresh vulnerability_fix missions + scores
    // Dependency/advisory data above is already written and valid on its
    // own, so a failure here does not roll it back or mark the repo
    // 'failed' — but this repo did not fully succeed (its missions are
    // stale or missing), so it still counts as a failure for exit-code
    // purposes (ADR 0008 §5).
    try {
      log("info", `[${label}] Generating missions`);
      const missionOutput = await missionWriter.generateMissionsForRepo(
        output.repoId,
        sourceRepoByPackage,
        githubToken,
      );

      log("info", `[${label}] Missions done`, {
        candidatesFound: missionOutput.candidatesFound,
        created: missionOutput.created,
        updated: missionOutput.updated,
      });

      await db
        .update(schema.ingestionRuns)
        .set({
          missionsCreated: missionOutput.created,
          missionsUpdated: missionOutput.updated,
        })
        .where(eq(schema.ingestionRuns.id, output.runId));
    } catch (err) {
      log(
        "error",
        `[${label}] Mission generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (err instanceof Error && err.stack) {
        log("error", err.stack);
      }
      return false;
    }

    return true;
  } catch (err) {
    log(
      "error",
      `[${label}] Ingestion failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (err instanceof Error && err.stack) {
      log("error", err.stack);
    }

    // Record the error on the repo row so it shows as 'failed' in the dashboard
    try {
      await db
        .update(schema.repos)
        .set({
          ingestionStatus: "failed",
          ingestionError: err instanceof Error ? err.message : String(err),
        })
        .where(eq(schema.repos.githubUrl, repo.githubUrl ?? repo.url));
    } catch {
      // Best-effort — don't mask the original error
    }

    return false;
  }
}

// ---------------------------------------------------------------------------
// Repo resolution helpers
// ---------------------------------------------------------------------------

/** Return all repos in DB with status 'pending' or 'failed'. */
async function resolvePending(db) {
  const rows = await db
    .select()
    .from(schema.repos)
    .where(
      or(eq(schema.repos.ingestionStatus, "pending"), eq(schema.repos.ingestionStatus, "failed")),
    );

  if (rows.length === 0) {
    log("info", "No repos with status 'pending' or 'failed' found in database.");
  }

  return rows;
}

/** Return a single repo from DB by UUID. */
async function resolveById(db, repoId) {
  const rows = await db.select().from(schema.repos).where(eq(schema.repos.id, repoId));

  if (rows.length === 0) {
    fatal(
      `No repo found in database with id="${repoId}". ` +
        `Seed the repo first, or use --repo-url for local testing.`,
    );
  }

  return rows;
}

/**
 * Resolve a repo by URL. If the URL exists in the DB, return that row.
 * If not, return a minimal stub — the writer will upsert it on first run.
 * Intended for local testing without pre-seeding the DB.
 */
async function resolveByUrl(db, url) {
  const normalised = url.replace(/\.git$/, "").replace(/\/$/, "");

  const rows = await db.select().from(schema.repos).where(eq(schema.repos.githubUrl, normalised));

  if (rows.length > 0) {
    log("info", `Repo found in database for URL: ${normalised}`);
    return rows;
  }

  log(
    "info",
    `Repo not found in database for URL: ${normalised}. ` +
      `Proceeding — writer will upsert on first run.`,
  );

  // Return a minimal stub that ingestRepo can use to kick off the pipeline.
  // repoInput will be fully populated from the GitHub API response.
  return [{ githubUrl: normalised, submittedBy: null }];
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/**
 * Extract owner and repo name from a GitHub URL.
 * Handles https://github.com/owner/name and https://github.com/owner/name.git
 */
function parseGithubUrl(url) {
  const match = url.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/);
  if (!match || !match[1] || !match[2]) {
    throw new Error(
      `Cannot parse GitHub owner/name from URL: "${url}". ` +
        `Expected format: https://github.com/owner/name`,
    );
  }
  return { owner: match[1], name: match[2] };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const triggeredBy = argValue(argv, "--triggered-by") ?? "cron";

  if (!["cron", "manual", "submit"].includes(triggeredBy)) {
    fatal(`--triggered-by must be "cron", "manual", or "submit", got "${triggeredBy}"`);
  }

  const repoId = argValue(argv, "--repo-id") ?? null;
  const repoUrl = argValue(argv, "--repo-url") ?? null;

  if (repoId && repoUrl) {
    fatal("Use either --repo-id or --repo-url, not both.");
  }

  return { triggeredBy, repoId, repoUrl };
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, message, data) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (data !== undefined) {
    console.log(`${prefix} ${message}`, JSON.stringify(data));
  } else {
    console.log(`${prefix} ${message}`);
  }
}

function logWarnings(label, warnings) {
  for (const w of warnings) {
    log("warn", `[${label}] ${w}`);
  }
}

// ---------------------------------------------------------------------------
// Fatal error — log and exit 1
// ---------------------------------------------------------------------------

function fatal(message) {
  log("error", `FATAL: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main();
