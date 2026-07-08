/**
 * Mission DB Writer
 *
 * Reads is_affected dependency_advisories rows for a repo, computes a
 * mission score and copy for each, and upserts missions / mission_scores.
 * Phase 2 generates vulnerability_fix missions only (ADR 0007, §1).
 *
 * missions has no unique constraint to target with ON CONFLICT (unlike
 * mission_scores, which is unique on mission_id) — this writer does a
 * manual check-then-write instead. Re-run safe: an existing mission's
 * title/description/action_hint are refreshed, but status and any
 * claim/resolution fields are never touched (ADR 0008, §2–3).
 *
 * db/types.ts and schema.ts are two independent representations of the
 * same rows (ADR 0008, §1) — this file is the boundary that converts
 * between them; nothing above the read query touches schema.ts.
 *
 * ADR: docs/adr/0008-mission-db-writer.md
 */

import { and, eq, sql } from "drizzle-orm";
import type { NeonDatabase, NeonTransaction } from "drizzle-orm/neon-serverless";
import {
  advisories,
  dependencies,
  dependencyAdvisories,
  missions,
  missionScores,
  repos,
  type Advisory as SchemaAdvisory,
  type Dependency as SchemaDependency,
  type Repo as SchemaRepo,
} from "../db/schema.js";
import type {
  Advisory as CoreAdvisory,
  Dependency as CoreDependency,
  OsvVersionRange,
  Repo as CoreRepo,
} from "../db/types.js";
import {
  computeMissionScore,
  type MissionScoreComputation,
  type MissionScoringContext,
} from "./mission-scorer.js";
import { generateMissionCopy } from "./mission-copy.js";

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface GenerateMissionsOutput {
  created: number;
  updated: number;
  /** is_affected dependency_advisories rows found for this repo — for logging */
  candidatesFound: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNeonDb = NeonDatabase<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNeonTx = NeonTransaction<any, any>;
/** Accepts both the outer db instance and the transaction callback parameter */
type DbOrTx = AnyNeonDb | AnyNeonTx;

// ---------------------------------------------------------------------------
// schema.ts -> db/types.ts row conversion (ADR 0008, §1)
// ---------------------------------------------------------------------------

function toCoreRepo(row: SchemaRepo): CoreRepo {
  return {
    id: row.id,
    github_url: row.githubUrl,
    owner: row.owner,
    name: row.name,
    default_branch: row.defaultBranch,
    description: row.description,
    stars: row.stars,
    open_issues_count: row.openIssuesCount,
    topics: row.topics,
    homepage_url: row.homepageUrl,
    ingestion_status: row.ingestionStatus,
    last_ingested_at: row.lastIngestedAt,
    ingestion_error: row.ingestionError,
    submitted_by: row.submittedBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function toCoreDependency(row: SchemaDependency): CoreDependency {
  return {
    id: row.id,
    repo_id: row.repoId,
    ecosystem: row.ecosystem,
    package_name: row.packageName,
    version_spec: row.versionSpec,
    resolved_version: row.resolvedVersion,
    dep_type: row.depType,
    latest_version: row.latestVersion,
    is_deprecated: row.isDeprecated,
    deprecation_note: row.deprecationNote,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function toCoreAdvisory(row: SchemaAdvisory): CoreAdvisory {
  return {
    id: row.id,
    osv_id: row.osvId,
    source: row.source,
    ecosystem: row.ecosystem,
    package_name: row.packageName,
    severity: row.severity,
    // numeric column -> Drizzle infers string; db/types.ts wants number (ADR 0007/0008)
    cvss_score: row.cvssScore === null ? null : Number(row.cvssScore),
    summary: row.summary,
    details: row.details,
    // jsonb columns have no $type set on schema.ts -> inferred as unknown.
    // Safe to narrow here: this data was written by our own OsvFetcher.
    affected_versions: row.affectedVersions as OsvVersionRange[],
    fixed_version: row.fixedVersion,
    published_at: row.publishedAt,
    modified_at: row.modifiedAt,
    raw_data: row.rawData as Record<string, unknown>,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// MissionWriter
// ---------------------------------------------------------------------------

export class MissionWriter {
  constructor(private readonly db: AnyNeonDb) {}

  /**
   * Generates/refreshes vulnerability_fix missions for every is_affected
   * dependency_advisories row belonging to this repo. All-or-nothing per
   * repo: wrapped in a single transaction.
   */
  async generateMissionsForRepo(repoId: string): Promise<GenerateMissionsOutput> {
    const repoRows = await this.db.select().from(repos).where(eq(repos.id, repoId));
    const repoRow = repoRows[0];
    if (repoRow === undefined) {
      throw new Error(`generateMissionsForRepo: no repo found for id ${repoId}`);
    }
    const repo = toCoreRepo(repoRow);

    const candidateRows = await this.db
      .select({ dependency: dependencies, advisory: advisories })
      .from(dependencyAdvisories)
      .innerJoin(dependencies, eq(dependencyAdvisories.dependencyId, dependencies.id))
      .innerJoin(advisories, eq(dependencyAdvisories.advisoryId, advisories.id))
      .where(and(eq(dependencies.repoId, repoId), eq(dependencyAdvisories.isAffected, true)));

    let created = 0;
    let updated = 0;

    await this.db.transaction(async (tx) => {
      for (const row of candidateRows) {
        const ctx: MissionScoringContext = {
          dependency: toCoreDependency(row.dependency),
          advisory: toCoreAdvisory(row.advisory),
          repo,
        };

        const score = computeMissionScore(ctx);
        const copy = generateMissionCopy(ctx, score);

        const { wasCreated, id: missionId } = await this.upsertMission(tx, {
          repoId,
          dependencyId: ctx.dependency.id,
          advisoryId: ctx.advisory.id,
          title: copy.title,
          description: copy.description,
          actionHint: copy.action_hint,
        });

        await this.upsertMissionScore(tx, missionId, score);

        if (wasCreated) {
          created++;
        } else {
          updated++;
        }
      }
    });

    return { created, updated, candidatesFound: candidateRows.length };
  }

  // ---------------------------------------------------------------------------
  // missions (manual check-then-write — no unique constraint, ADR 0008 §2)
  // ---------------------------------------------------------------------------

  private async upsertMission(
    tx: DbOrTx,
    input: {
      repoId: string;
      dependencyId: string;
      advisoryId: string;
      title: string;
      description: string;
      actionHint: string | null;
    },
  ): Promise<{ id: string; wasCreated: boolean }> {
    const existing = await tx
      .select({ id: missions.id })
      .from(missions)
      .where(
        and(
          eq(missions.dependencyId, input.dependencyId),
          eq(missions.advisoryId, input.advisoryId),
        ),
      )
      .limit(1);

    const existingRow = existing[0];

    if (existingRow !== undefined) {
      // Copy only — status/claimed_by/claimed_at/resolved_at/dismissed_at/
      // dismiss_reason are user-driven state a re-run must never overwrite
      // (ADR 0008 §3).
      await tx
        .update(missions)
        .set({
          title: input.title,
          description: input.description,
          actionHint: input.actionHint,
          updatedAt: new Date(),
        })
        .where(eq(missions.id, existingRow.id));

      return { id: existingRow.id, wasCreated: false };
    }

    const inserted = await tx
      .insert(missions)
      .values({
        repoId: input.repoId,
        title: input.title,
        description: input.description,
        actionHint: input.actionHint,
        missionType: "vulnerability_fix",
        advisoryId: input.advisoryId,
        dependencyId: input.dependencyId,
      })
      .returning({ id: missions.id });

    const insertedRow = inserted[0];
    if (insertedRow === undefined) {
      throw new Error(
        `upsertMission: insert returned no row for dependency ${input.dependencyId} / advisory ${input.advisoryId}`,
      );
    }

    return { id: insertedRow.id, wasCreated: true };
  }

  // ---------------------------------------------------------------------------
  // mission_scores (real onConflictDoUpdate — mission_id is unique)
  // ---------------------------------------------------------------------------

  private async upsertMissionScore(
    tx: DbOrTx,
    missionId: string,
    score: MissionScoreComputation,
  ): Promise<void> {
    await tx
      .insert(missionScores)
      .values({
        missionId,
        impactScore: score.impact_score.toFixed(1),
        ecosystemValueScore: score.ecosystem_value_score.toFixed(1),
        compositeScore: score.composite_score.toFixed(1),
        effortLabel: score.effort_label,
        impactInputs: score.impact_inputs,
        ecosystemValueInputs: score.ecosystem_value_inputs,
        effortInputs: score.effort_inputs,
        confidence: score.confidence,
        confidenceNotes: score.confidence_notes,
        confidenceFlags: score.confidence_flags,
        scoringVersion: score.scoring_version,
      })
      .onConflictDoUpdate({
        target: missionScores.missionId,
        set: {
          impactScore: sql`excluded.impact_score`,
          ecosystemValueScore: sql`excluded.ecosystem_value_score`,
          compositeScore: sql`excluded.composite_score`,
          effortLabel: sql`excluded.effort_label`,
          impactInputs: sql`excluded.impact_inputs`,
          ecosystemValueInputs: sql`excluded.ecosystem_value_inputs`,
          effortInputs: sql`excluded.effort_inputs`,
          confidence: sql`excluded.confidence`,
          confidenceNotes: sql`excluded.confidence_notes`,
          confidenceFlags: sql`excluded.confidence_flags`,
          scoringVersion: sql`excluded.scoring_version`,
          updatedAt: new Date(),
        },
      });
  }
}
