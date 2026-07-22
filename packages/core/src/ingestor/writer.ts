/**
 * Ingestion DB Writer
 *
 * Writes all Phase 1 ingestion data to the database using the Drizzle query
 * API. Every write is an upsert so the daily cron can re-run safely without
 * producing duplicate rows.
 *
 * Write order (respects foreign-key dependencies):
 *   1. repos              — upsert on github_url
 *   2. ingestion_runs     — insert (new row per run); returned for later update
 *   3. advisories         — upsert on osv_id (independent of repo)
 *   4. dependencies       — upsert on (repo_id, package_name, dep_type)
 *   5. dependency_advisories — upsert on (dependency_id, advisory_id)
 *   6. ingestion_runs     — final status + count update on finish
 *
 * Steps 3–5 are wrapped in a transaction: either all dependency + advisory
 * rows for a repo land, or none do. The ingestion_run row lives outside the
 * transaction so its status is always visible for monitoring.
 *
 * Phase 1 scope — out of scope:
 *   - missions / mission_scores (Phase 2)
 *   - resolvedVersion population (requires lock file)
 *
 * ADR: docs/adr/0005-migration-tooling-drizzle.md
 */

import { eq, inArray, sql } from "drizzle-orm";
import type { NeonDatabase, NeonTransaction } from "drizzle-orm/neon-serverless";
import {
  advisories,
  dependencyAdvisories,
  dependencies,
  ingestionRuns,
  repos,
  type NewAdvisory,
  type NewDependency,
  type NewIngestionRun,
} from "../db/schema.js";
import type { OsvFetchResult } from "./osv.js";
import type { NpmRegistryFetchResult } from "./registry.js";
import type { IngestorResult } from "./interface.js";

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface RepoInput {
  githubUrl: string;
  owner: string;
  name: string;
  defaultBranch: string;
  description: string | null;
  stars: number;
  openIssuesCount: number;
  topics: string[];
  homepageUrl: string | null;
  submittedBy: string | null;
}

export interface WriteIngestionInput {
  repo: RepoInput;
  ingestorResult: IngestorResult;
  osvResult: OsvFetchResult;
  registryResult: NpmRegistryFetchResult;
  triggeredBy: "cron" | "manual" | "submit";
}

export interface WriteIngestionOutput {
  repoId: string;
  runId: string;
  status: "complete" | "skipped";
  dependenciesWritten: number;
  advisoriesWritten: number;
  dependencyAdvisoriesWritten: number;
  /** All warnings collected across the ingestion pipeline */
  allWarnings: string[];
}

// ---------------------------------------------------------------------------
// IngestionWriter
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNeonDb = NeonDatabase<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNeonTx = NeonTransaction<any, any>;
/** Accepts both the outer db instance and the transaction callback parameter */
type DbOrTx = AnyNeonDb | AnyNeonTx;

export class IngestionWriter {
  constructor(private readonly db: AnyNeonDb) {}

  /**
   * Run the full write sequence for one ingestion pass.
   * Errors from steps 3–5 are caught, recorded on the run row, then rethrown
   * so the caller (ingest.js) can exit non-zero for CI visibility.
   */
  async write(input: WriteIngestionInput): Promise<WriteIngestionOutput> {
    const allWarnings = [
      ...input.ingestorResult.warnings,
      ...input.osvResult.warnings,
      ...input.registryResult.warnings,
    ];

    // 1. Upsert repo
    const repoId = await this.upsertRepo(input.repo);

    // 2. Open ingestion run
    const runId = await this.openRun(repoId, input.triggeredBy);

    let dependenciesWritten = 0;
    let advisoriesWritten = 0;
    let dependencyAdvisoriesWritten = 0;

    try {
      // 3–5. Transactional: advisories → dependencies → dependency_advisories
      const counts = await this.db.transaction(async (tx) => {
        const advCount = await this.upsertAdvisories(tx, input.osvResult.advisories);
        const { depCount, depAdvisoryCount } = await this.upsertDependencies(
          tx,
          repoId,
          input.ingestorResult,
          input.registryResult,
          input.osvResult,
        );
        return { advCount, depCount, depAdvisoryCount };
      });

      dependenciesWritten = counts.depCount;
      advisoriesWritten = counts.advCount;
      dependencyAdvisoriesWritten = counts.depAdvisoryCount;
    } catch (err) {
      await this.closeRun(runId, "failed", 0, 0, err);
      throw err;
    }

    // 6. Close run + mark repo complete/skipped
    // "Skipped" (not "complete", not "failed"): the pipeline ran to
    // completion without error, but ingestorResult.package_json_resolved
    // being false means there was no manifest to actually analyze — a
    // repo with a genuinely empty-but-valid package.json still counts as
    // "complete" (see IngestorResult's own doc comment). Using a status
    // distinct from "failed" specifically so resolvePending() — which
    // only re-picks 'pending'/'failed' — never retries a repo that will
    // never have a package.json to find.
    const finalStatus: "complete" | "skipped" = input.ingestorResult.package_json_resolved
      ? "complete"
      : "skipped";

    await this.closeRun(runId, finalStatus, dependenciesWritten, advisoriesWritten, null);

    await this.db
      .update(repos)
      .set({
        ingestionStatus: finalStatus,
        lastIngestedAt: new Date(),
        ingestionError:
          finalStatus === "skipped" ? (input.ingestorResult.warnings[0] ?? null) : null,
      })
      .where(eq(repos.id, repoId));

    return {
      repoId,
      runId,
      status: finalStatus,
      dependenciesWritten,
      advisoriesWritten,
      dependencyAdvisoriesWritten,
      allWarnings,
    };
  }

  // ---------------------------------------------------------------------------
  // repos
  // ---------------------------------------------------------------------------

  private async upsertRepo(input: RepoInput): Promise<string> {
    const result = await this.db
      .insert(repos)
      .values({
        githubUrl: input.githubUrl,
        owner: input.owner,
        name: input.name,
        defaultBranch: input.defaultBranch,
        description: input.description,
        stars: input.stars,
        openIssuesCount: input.openIssuesCount,
        topics: input.topics,
        homepageUrl: input.homepageUrl,
        submittedBy: input.submittedBy,
        ingestionStatus: "running",
      })
      .onConflictDoUpdate({
        target: repos.githubUrl,
        set: {
          owner: input.owner,
          name: input.name,
          defaultBranch: input.defaultBranch,
          description: input.description,
          stars: input.stars,
          openIssuesCount: input.openIssuesCount,
          topics: input.topics,
          homepageUrl: input.homepageUrl,
          ingestionStatus: "running",
          updatedAt: new Date(),
        },
      })
      .returning({ id: repos.id });

    const row = result[0];
    if (row === undefined) {
      throw new Error(`upsertRepo returned no row for ${input.githubUrl}`);
    }
    return row.id;
  }

  // ---------------------------------------------------------------------------
  // ingestion_runs
  // ---------------------------------------------------------------------------

  private async openRun(
    repoId: string,
    triggeredBy: NewIngestionRun["triggeredBy"],
  ): Promise<string> {
    const result = await this.db
      .insert(ingestionRuns)
      .values({ repoId, triggeredBy, status: "running" })
      .returning({ id: ingestionRuns.id });

    const row = result[0];
    if (row === undefined) {
      throw new Error(`openRun returned no row for repo ${repoId}`);
    }
    return row.id;
  }

  private async closeRun(
    runId: string,
    status: "complete" | "failed" | "skipped",
    dependenciesFound: number,
    advisoriesFetched: number,
    err: unknown,
  ): Promise<void> {
    await this.db
      .update(ingestionRuns)
      .set({
        status,
        dependenciesFound,
        advisoriesFetched,
        errorMessage: stringifyError(err),
        errorStack: err instanceof Error ? (err.stack ?? null) : null,
        finishedAt: new Date(),
      })
      .where(eq(ingestionRuns.id, runId));
  }

  // ---------------------------------------------------------------------------
  // advisories
  // ---------------------------------------------------------------------------

  private async upsertAdvisories(
    tx: DbOrTx,
    advisoryMap: Map<string, NewAdvisory>,
  ): Promise<number> {
    if (advisoryMap.size === 0) return 0;

    const rows = [...advisoryMap.values()];

    // All advisories in one round-trip.
    // Conflict on osv_id — update mutable fields. CVSS scores and severity
    // are revised over time; rawData keeps the latest OSV snapshot.
    await tx
      .insert(advisories)
      .values(rows)
      .onConflictDoUpdate({
        target: advisories.osvId,
        set: {
          severity: sql`excluded.severity`,
          cvssScore: sql`excluded.cvss_score`,
          summary: sql`excluded.summary`,
          details: sql`excluded.details`,
          affectedVersions: sql`excluded.affected_versions`,
          fixedVersion: sql`excluded.fixed_version`,
          modifiedAt: sql`excluded.modified_at`,
          rawData: sql`excluded.raw_data`,
          updatedAt: new Date(),
        },
      });

    return rows.length;
  }

  // ---------------------------------------------------------------------------
  // dependencies + dependency_advisories
  // ---------------------------------------------------------------------------

  private async upsertDependencies(
    tx: DbOrTx,
    repoId: string,
    ingestorResult: IngestorResult,
    registryResult: NpmRegistryFetchResult,
    osvResult: OsvFetchResult,
  ): Promise<{ depCount: number; depAdvisoryCount: number }> {
    if (ingestorResult.dependencies.length === 0) {
      return { depCount: 0, depAdvisoryCount: 0 };
    }

    // Build dependency rows, merging registry metadata in
    const depRows: NewDependency[] = ingestorResult.dependencies.map((dep) => {
      const meta = registryResult.metadata.get(dep.package_name);
      return {
        repoId,
        ecosystem: "npm",
        packageName: dep.package_name,
        versionSpec: dep.version_spec,
        depType: dep.dep_type,
        resolvedVersion: null, // lock file parsing deferred
        latestVersion: meta?.latestVersion ?? null,
        isDeprecated: meta?.isDeprecated ?? false,
        deprecationNote: meta?.deprecationNote ?? null,
      };
    });

    // Conflict on (repo_id, package_name, dep_type)
    const upserted = await tx
      .insert(dependencies)
      .values(depRows)
      .onConflictDoUpdate({
        target: [dependencies.repoId, dependencies.packageName, dependencies.depType],
        set: {
          versionSpec: sql`excluded.version_spec`,
          latestVersion: sql`excluded.latest_version`,
          isDeprecated: sql`excluded.is_deprecated`,
          deprecationNote: sql`excluded.deprecation_note`,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: dependencies.id,
        packageName: dependencies.packageName,
        depType: dependencies.depType,
      });

    // "packageName:depType" → dependency UUID
    const depIdMap = new Map<string, string>();
    for (const row of upserted) {
      depIdMap.set(`${row.packageName}:${row.depType}`, row.id);
    }

    let depAdvisoryCount = 0;
    const osvIds = [...osvResult.advisories.keys()];

    if (osvIds.length > 0) {
      // Re-fetch advisory UUIDs by osv_id — these were just upserted above
      const advisoryRows = await tx
        .select({ id: advisories.id, osvId: advisories.osvId })
        .from(advisories)
        .where(inArray(advisories.osvId, osvIds));

      const advisoryIdMap = new Map<string, string>();
      for (const row of advisoryRows) {
        advisoryIdMap.set(row.osvId, row.id);
      }

      // One dependency_advisories row per (dep, advisory) pair
      const depAdvRows: {
        dependencyId: string;
        advisoryId: string;
        isAffected: boolean;
        matchMethod: string;
      }[] = [];

      for (const [packageName, osvIdList] of osvResult.packageAdvisoryMap) {
        const affectedDeps = ingestorResult.dependencies.filter(
          (d) => d.package_name === packageName,
        );

        for (const dep of affectedDeps) {
          const dependencyId = depIdMap.get(`${packageName}:${dep.dep_type}`);
          if (dependencyId === undefined) continue;

          for (const osvId of osvIdList) {
            const advisoryId = advisoryIdMap.get(osvId);
            if (advisoryId === undefined) continue;

            depAdvRows.push({
              dependencyId,
              advisoryId,
              // Phase 1: conservative — any advisory for a package is flagged
              // as potentially affecting. Precise version-range matching
              // requires a resolved version (lock file), deferred to Phase 2.
              isAffected: true,
              matchMethod: "version_spec",
            });
          }
        }
      }

      if (depAdvRows.length > 0) {
        await tx
          .insert(dependencyAdvisories)
          .values(depAdvRows)
          .onConflictDoUpdate({
            target: [dependencyAdvisories.dependencyId, dependencyAdvisories.advisoryId],
            set: {
              isAffected: sql`excluded.is_affected`,
              matchMethod: sql`excluded.match_method`,
            },
          });

        depAdvisoryCount = depAdvRows.length;
      }
    }

    return { depCount: upserted.length, depAdvisoryCount };
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Convert an unknown thrown value to a storable string, without relying on
 * the default Object.prototype.toString() for plain objects (which would
 * just produce "[object Object]" and lose all diagnostic value).
 */
function stringifyError(err: unknown): string | null {
  if (err === null || err === undefined) return null;
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error (not serializable)";
  }
}
