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
 * Reads schema.ts rows directly and passes them straight into
 * MissionScoringContext — as of ADR 0011, schema.ts is the sole row-type
 * source, so no read-boundary conversion function is needed here anymore.
 *
 * ADR 0029 (Step 5): generateMissionsForRepo() now optionally prefetches
 * breaking-change signals for every candidate BEFORE db.transaction()
 * opens — network calls to arbitrary third-party GitHub repos can't
 * happen inside that transaction (ADR 0009's own reasoning for switching
 * to neon-serverless applies here too: don't hold a Neon connection open
 * across slow external I/O). sourceRepoByPackage/githubToken are both
 * optional so this stays fully backward compatible: omit them and every
 * candidate's ctx.effortSignals is undefined, identical to pre-Step-5
 * behavior.
 *
 * ADR 0032: the same prefetch-before-transaction shape now also covers
 * downstream_dependents — one paced libraries.io call for the analyzed
 * repo's own published package(s) (max across a monorepo's links), gated
 * on an optional librariesIoApiKey. Omit it and every candidate's
 * ctx.downstreamDependents stays absent: identical to pre-ADR-0032
 * behavior.
 *
 * ADR: docs/adr/0008-mission-db-writer.md
 *      docs/adr/0011-schema-as-single-type-source.md
 *      docs/adr/0029-breaking-change-signals.md
 *      docs/adr/0032-downstream-dependents.md
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
  type Advisory,
  type Dependency,
} from "../db/schema.js";
import {
  computeMissionScore,
  extractVersionFloor,
  type MissionScoreComputation,
  type MissionScoringContext,
} from "./mission-scorer.js";
import { generateMissionCopy } from "./mission-copy.js";
// Scorer -> ingestor, same direction (and same reasoning) as
// mission-scorer.ts's own EffortSignals type import — writer.ts is the
// glue point ADR 0029 Decision 2 names explicitly: it already imports
// mission-scorer.ts, so it's the natural place to resolve the floor and
// call the prefetch, rather than adding a new cross-layer edge anywhere
// else.
import {
  prefetchEffortSignals,
  type EffortSignalRequest,
  type EffortSignals,
} from "../ingestor/changelog-signals.js";
import type { SourceRepoRef } from "../ingestor/source-repo.js";
import { fetchDownstreamDependents } from "../ingestor/downstream-dependents.js";

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface GenerateMissionsOutput {
  created: number;
  updated: number;
  /** is_affected dependency_advisories rows found for this repo — for logging */
  candidatesFound: number;
  /** Non-fatal downstream-dependents lookup observations (ADR 0032) — for logging */
  warnings: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNeonDb = NeonDatabase<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNeonTx = NeonTransaction<any, any>;
/** Accepts both the outer db instance and the transaction callback parameter */
type DbOrTx = AnyNeonDb | AnyNeonTx;

// ---------------------------------------------------------------------------
// MissionWriter
// ---------------------------------------------------------------------------

/**
 * Same key shape prefetchEffortSignalsForCandidates() builds requests
 * under and generateMissionsForRepo()'s per-candidate loop looks results
 * up by — kept as one function so the two can never drift apart. "null"
 * is a safe sentinel here (not a real npm/PyPI/Go version string) rather
 * than String(null) === "null" being an accident.
 */
function buildSignalKey(dependencyId: string, targetVersion: string | null): string {
  return `${dependencyId}:${targetVersion ?? "null"}`;
}

export class MissionWriter {
  constructor(private readonly db: AnyNeonDb) {}

  /**
   * Generates/refreshes vulnerability_fix missions for every is_affected
   * dependency_advisories row belonging to this repo. All-or-nothing per
   * repo: the DB writes are wrapped in a single transaction.
   *
   * sourceRepoByPackage, githubToken, and librariesIoApiKey are all
   * optional (ADR 0029 Step 5 / ADR 0032) — omit them (or call with just
   * repoId, as pre-Step-5 callers still do) and every candidate's
   * ctx.effortSignals stays undefined and every ctx.downstreamDependents
   * stays absent: identical to the old unconditional false/[] + null +
   * both-flags-set behavior. Pass librariesIoApiKey to actually resolve
   * downstream_dependents for this repo's own published package.
   */
  async generateMissionsForRepo(
    repoId: string,
    sourceRepoByPackage?: Map<string, SourceRepoRef | null>,
    githubToken?: string | null,
    librariesIoApiKey?: string | null,
  ): Promise<GenerateMissionsOutput> {
    const repoRows = await this.db.select().from(repos).where(eq(repos.id, repoId));
    const repoRow = repoRows[0];
    if (repoRow === undefined) {
      throw new Error(`generateMissionsForRepo: no repo found for id ${repoId}`);
    }

    const candidateRows = await this.db
      .select({ dependency: dependencies, advisory: advisories })
      .from(dependencyAdvisories)
      .innerJoin(dependencies, eq(dependencyAdvisories.dependencyId, dependencies.id))
      .innerJoin(advisories, eq(dependencyAdvisories.advisoryId, advisories.id))
      .where(and(eq(dependencies.repoId, repoId), eq(dependencyAdvisories.isAffected, true)));

    // ADR 0029, Step 5: prefetch BEFORE the transaction opens — see the
    // module docstring for why this can't happen inside it. Undefined
    // sourceRepoByPackage short-circuits to an empty map with zero
    // network calls, not just zero resolved signals — the whole point of
    // an optional parameter is that omitting it costs nothing.
    const effortSignalsByKey =
      sourceRepoByPackage === undefined
        ? new Map<string, EffortSignals>()
        : await this.prefetchEffortSignalsForCandidates(
            candidateRows,
            sourceRepoByPackage,
            githubToken ?? null,
          );

    // ADR 0032: one paced libraries.io listing (1–5 requests) for the
    // analyzed repo's own published package(s) — also before the
    // transaction opens, same reasoning as above. Skipped entirely with
    // zero network calls when no key was passed or when there are no
    // candidates to score; any failure inside fetchDownstreamDependents
    // is non-fatal by contract and surfaces as warnings instead.
    let downstreamDependents: number | undefined;
    let downstreamWarnings: string[] = [];
    if (librariesIoApiKey != null && candidateRows.length > 0) {
      const dependentsResult = await fetchDownstreamDependents(
        { owner: repoRow.owner, name: repoRow.name },
        librariesIoApiKey,
      );
      downstreamDependents = dependentsResult.count ?? undefined;
      downstreamWarnings = dependentsResult.warnings;
    }

    let created = 0;
    let updated = 0;

    await this.db.transaction(async (tx) => {
      for (const row of candidateRows) {
        const targetVersion = row.advisory.fixedVersion ?? row.dependency.latestVersion;
        const signals = effortSignalsByKey.get(buildSignalKey(row.dependency.id, targetVersion));
        // exactOptionalPropertyTypes: effortSignals?: EffortSignals means
        // "may be absent," not "may be undefined" — Map.get()'s
        // `T | undefined` return can't be assigned directly. Spreading
        // conditionally omits the key entirely when there's nothing to
        // report, rather than setting it to undefined.
        const ctx: MissionScoringContext = {
          dependency: row.dependency,
          advisory: row.advisory,
          repo: repoRow,
          ...(signals !== undefined && { effortSignals: signals }),
          ...(downstreamDependents !== undefined && { downstreamDependents }),
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

    return {
      created,
      updated,
      candidatesFound: candidateRows.length,
      warnings: downstreamWarnings,
    };
  }

  /**
   * Builds one EffortSignalRequest per candidate — sourceRepo looked up by
   * package name, currentFloor derived via mission-scorer.ts's own
   * extractVersionFloor() (the exact floor semver_bump/pep440_bump already
   * use, not a second, possibly-inconsistent estimate) — and resolves them
   * all through changelog-signals.ts's bounded-concurrency batch fetch.
   */
  private async prefetchEffortSignalsForCandidates(
    candidateRows: { dependency: Dependency; advisory: Advisory }[],
    sourceRepoByPackage: Map<string, SourceRepoRef | null>,
    githubToken: string | null,
  ): Promise<Map<string, EffortSignals>> {
    const requests: EffortSignalRequest[] = candidateRows.map((row) => {
      const targetVersion = row.advisory.fixedVersion ?? row.dependency.latestVersion;
      return {
        key: buildSignalKey(row.dependency.id, targetVersion),
        sourceRepo: sourceRepoByPackage.get(row.dependency.packageName) ?? null,
        ecosystem: row.dependency.ecosystem,
        currentFloor: extractVersionFloor(row.dependency.ecosystem, row.dependency.versionSpec),
        targetVersion,
      };
    });

    return prefetchEffortSignals(requests, githubToken);
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
        impactScore: score.impact_score,
        ecosystemValueScore: score.ecosystem_value_score,
        compositeScore: score.composite_score,
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
