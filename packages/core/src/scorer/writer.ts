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
 * Auto-resolution: after the candidate loop, every open/claimed mission of
 * this repo whose (dependency_id, advisory_id) pair produced no candidate
 * this run is closed as "resolved" inside the same transaction — the
 * dependency left the manifest, the advisory no longer matches, or OSV
 * withdrew it. "dismissed" keeps its human decision; a previously
 * auto-resolved mission whose pair returns is reopened. See
 * resolveStaleMissions().
 *
 * ADR: docs/adr/0008-mission-db-writer.md
 *      docs/adr/0011-schema-as-single-type-source.md
 *      docs/adr/0029-breaking-change-signals.md
 *      docs/adr/0032-downstream-dependents.md
 *      docs/adr/0043-bulk-mission-writes.md
 */

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { type AnyNeonDb, type DbOrTx } from "../db/db-types.js";
import {
  advisories,
  dependencies,
  dependencyAdvisories,
  missions,
  missionScores,
  repos,
  type Advisory,
  type Dependency,
  type MissionStatus,
  type MissionType,
} from "../db/schema.js";
import {
  computeMissionScore,
  extractVersionFloor,
  type MissionScoreComputation,
  type MissionScoringContext,
} from "./mission-scorer.js";
import { generateMissionCopy, type MissionCopyInput } from "./mission-copy.js";
import { classifyAllMissions } from "./mission-type-detector.js";
// Scorer -> ingestor, same direction (and same reasoning) as
// mission-scorer.ts's own EffortSignals type import — writer.ts is the
// glue point ADR 0029 Decision 2 names explicitly: it already imports
// mission-scorer.ts, so it's the natural place to resolve the floor and
// call the prefetch, rather than adding a new cross-layer edge anywhere
// else.
import {
  buildSignalKey,
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
  /**
   * Open/claimed missions of this repo whose (dependency_id, advisory_id)
   * pair is no longer among the current candidates — auto-closed as
   * "resolved" this run. For logging/visibility; ingestion_runs has no
   * column for it (adding one would be a migration for a nice-to-have).
   */
  resolved: number;
  /** is_affected dependency_advisories rows found for this repo — for logging */
  candidatesFound: number;
  /** Non-fatal downstream-dependents lookup observations (ADR 0032) — for logging */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// MissionWriter
// ---------------------------------------------------------------------------

/** Key shape for the bulk existing-missions lookup — see selectExistingMissionIds(). */
function missionPairKey(dependencyId: string, advisoryId: string): string {
  return `${dependencyId}:${advisoryId}`;
}

export class MissionWriter {
  constructor(private readonly db: AnyNeonDb) {}

  /**
   * Generates/refreshes missions for every dependency of this repo.
   * Mission types: vulnerability_fix, dep_update, maintenance, license_issue.
   * All-or-nothing per repo: the DB writes are wrapped in a single transaction.
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

    // Fetch ALL dependencies for this repo (not just those with advisories)
    const allDeps = await this.db
      .select()
      .from(dependencies)
      .where(eq(dependencies.repoId, repoId));

    // Fetch advisories for these dependencies
    const depIds = allDeps.map((d) => d.id);
    const advisoryRows =
      depIds.length > 0
        ? await this.db
            .select({ dependency: dependencies, advisory: advisories })
            .from(dependencyAdvisories)
            .innerJoin(dependencies, eq(dependencyAdvisories.dependencyId, dependencies.id))
            .innerJoin(advisories, eq(dependencyAdvisories.advisoryId, advisories.id))
            .where(and(inArray(dependencies.id, depIds), eq(dependencyAdvisories.isAffected, true)))
        : [];

    // Group advisories by package name — matches the lookup key used by
    // classifyAllMissions() in mission-type-detector.ts.
    const advisoryMap = new Map<string, Advisory[]>();
    for (const row of advisoryRows) {
      const existing = advisoryMap.get(row.dependency.packageName) ?? [];
      existing.push(row.advisory);
      advisoryMap.set(row.dependency.packageName, existing);
    }

    // Build registry metadata map for deprecation/archival info
    const registryMetadata = new Map<string, { isDeprecated?: boolean; isArchived?: boolean }>();
    for (const dep of allDeps) {
      if (dep.isDeprecated) {
        registryMetadata.set(dep.packageName, { isDeprecated: true });
      }
    }

    // Classify all dependencies into mission types
    const classifications = classifyAllMissions(allDeps, advisoryMap, registryMetadata);

    // Prepare candidate rows for prefetch (only vulnerability_fix for effort signals)
    const vulnCandidates = advisoryRows.filter((r) =>
      classifications.some(
        (c) => c.dependencyId === r.dependency.id && c.classification.type === "vulnerability_fix",
      ),
    );

    // ADR 0029, Step 5: prefetch BEFORE the transaction opens
    const effortSignalsByKey =
      sourceRepoByPackage === undefined || vulnCandidates.length === 0
        ? new Map<string, EffortSignals>()
        : await this.prefetchEffortSignalsForCandidates(
            vulnCandidates,
            sourceRepoByPackage,
            githubToken ?? null,
          );

    // ADR 0032: one paced libraries.io listing for the analyzed repo's own published package(s)
    let downstreamDependents: number | undefined;
    let downstreamWarnings: string[] = [];
    if (librariesIoApiKey != null && allDeps.length > 0) {
      const dependentsResult = await fetchDownstreamDependents(
        { owner: repoRow.owner, name: repoRow.name },
        librariesIoApiKey,
      );
      downstreamDependents = dependentsResult.count ?? undefined;
      downstreamWarnings = dependentsResult.warnings;
    }

    let created = 0;
    let updated = 0;
    let resolved = 0;

    await this.db.transaction(async (tx) => {
      // Build pairs for existing mission lookup (all classified dependencies)
      const classificationPairs = classifications.map((c) => ({
        dependencyId: c.dependencyId,
        advisoryId: c.classification.advisory?.id ?? null,
        type: c.classification.type,
      }));

      const existingMissions = await this.selectExistingMissions(tx, classificationPairs);

      // Pre-build an O(1) dependency lookup and the per-classification
      // mission inputs. Doing this in JS once, before any DB writes, is
      // what turns the original 2N round-trip loop into a constant number
      // of bulk statements (ADR 0042). The Map replaces an allDeps.find()
      // per iteration that was O(N) — itself O(N²) for the loop.
      const depsById = new Map<string, Dependency>();
      for (const dep of allDeps) {
        depsById.set(dep.id, dep);
      }

      interface PreparedRow {
        existingMissionId: string | null;
        /** Reopen this existing mission from "resolved" → "open" (ADR 0008 §3). */
        reopen: boolean;
        missionInput: {
          repoId: string;
          dependencyId: string;
          advisoryId: string | null;
          title: string;
          description: string;
          actionHint: string | null;
          missionType: MissionType;
        };
        score: MissionScoreComputation;
      }

      const prepared: PreparedRow[] = [];
      for (const { dependencyId, classification } of classifications) {
        const dependency = depsById.get(dependencyId);
        if (!dependency) continue;

        // Build effort signals for vulnerability_fix only
        let signals: EffortSignals | undefined;
        if (classification.type === "vulnerability_fix" && classification.advisory) {
          const advTargetVersion = classification.advisory.fixedVersion ?? dependency.latestVersion;
          signals = effortSignalsByKey.get(buildSignalKey(dependency.id, advTargetVersion));
        }

        const ctx: MissionScoringContext = {
          dependency,
          advisory: classification.advisory ?? {
            id: "00000000-0000-0000-0000-000000000000",
            osvId: "N/A",
            source: "osv",
            ecosystem: dependency.ecosystem,
            packageName: dependency.packageName,
            severity: "unknown",
            cvssScore: null,
            epssScore: null,
            summary: "No advisory",
            details: null,
            affectedVersions: [],
            fixedVersion: null,
            publishedAt: null,
            modifiedAt: null,
            rawData: {},
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          repo: repoRow,
          ...(signals !== undefined && { effortSignals: signals }),
          ...(downstreamDependents !== undefined && { downstreamDependents }),
        };

        const score = computeMissionScore(ctx);

        // Build mission copy input based on type
        const copyInput: MissionCopyInput = {
          type: classification.type,
          ctx,
          score,
          ...(classification.targetVersion !== undefined && {
            targetVersion: classification.targetVersion,
          }),
          ...(classification.maintenanceReason !== undefined && {
            maintenanceReason: classification.maintenanceReason,
          }),
        };

        const copy = generateMissionCopy(copyInput);

        const missionInput = {
          repoId,
          dependencyId: dependency.id,
          advisoryId: classification.advisory?.id ?? null,
          title: copy.title,
          description: copy.description,
          actionHint: copy.action_hint,
          missionType: classification.type,
        };

        // Look up existing mission by dependency_id + advisory_id (or just dependency_id for non-vuln)
        let existingKey: string;
        if (classification.advisory) {
          existingKey = missionPairKey(dependency.id, classification.advisory.id);
        } else {
          // For non-vulnerability missions, match by dependency_id only (advisory_id is null)
          existingKey = `dep-only:${dependency.id}:${classification.type}`;
        }

        const existing = existingMissions.get(existingKey);

        prepared.push({
          existingMissionId: existing?.id ?? null,
          reopen: existing?.status === "resolved",
          missionInput,
          score,
        });
      }

      // Three bulk statements replace the original 2N per-row round-trips
      // (ADR 0042): 1) insert all new missions, 2) update all existing
      // missions, 3) upsert all mission scores. Each is one round-trip on
      // the WebSocket-backed neon-serverless driver.
      const {
        newMissionIds,
        created: createdCount,
        updated: updatedCount,
      } = await this.bulkWriteMissions(tx, prepared);

      await this.bulkUpsertMissionScores(
        tx,
        prepared.map((row, index) => ({
          missionId: row.existingMissionId ?? newMissionIds[index] ?? null,
          score: row.score,
        })),
      );

      created = createdCount;
      updated = updatedCount;

      const processedMissionIds: string[] = prepared.map(
        (row, index) => row.existingMissionId ?? newMissionIds[index] ?? "",
      );
      resolved = await this.resolveStaleMissions(tx, repoId, processedMissionIds);
    });

    return {
      created,
      updated,
      resolved,
      candidatesFound: classifications.length,
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
  // missions (manual check-then-write — no unique constraint, ADR 0008 §2;
  // the "check" half is selectExistingMissionIds's single bulk query)
  // ---------------------------------------------------------------------------

  /**
   * Resolves which of this repo's candidate pairs already have a mission,
   * in ONE query: SELECT id, dependency_id, advisory_id, mission_type, status WHERE
   * dependency_id IN (this repo's candidate dependencies) — leaning on
   * migration 0006's idx_missions_dependency_id. Rows whose
   * dependency_id/advisory_id were nulled by their ON DELETE SET NULL
   * foreign keys can never match a candidate pair and are skipped.
   */
  private async selectExistingMissions(
    tx: DbOrTx,
    pairs: { dependencyId: string; advisoryId: string | null; type: string }[],
  ): Promise<Map<string, { id: string; status: MissionStatus }>> {
    const result = new Map<string, { id: string; status: MissionStatus }>();
    if (pairs.length === 0) return result;

    const dependencyIds = [...new Set(pairs.map((p) => p.dependencyId))];
    const rows = await tx
      .select({
        id: missions.id,
        dependencyId: missions.dependencyId,
        advisoryId: missions.advisoryId,
        missionType: missions.missionType,
        status: missions.status,
      })
      .from(missions)
      .where(inArray(missions.dependencyId, dependencyIds));

    for (const row of rows) {
      if (row.dependencyId === null) continue;
      let key: string;
      if (row.advisoryId) {
        key = missionPairKey(row.dependencyId, row.advisoryId);
      } else {
        key = `dep-only:${row.dependencyId}:${row.missionType}`;
      }
      result.set(key, { id: row.id, status: row.status });
    }
    return result;
  }

  /**
   * Auto-closes this repo's remaining open/claimed missions — the ones
   * whose (dependency_id, advisory_id) pair produced no candidate this run:
   * the dependency left the manifest, the advisory no longer matches, or
   * OSV withdrew it. This is what makes "resolved" a reachable status and
   * keeps the board truthful against the repo's current state instead of
   * accumulating permanently-open missions for problems that may already
   * be gone.
   *
   * Deliberate edges:
   * - "dismissed" rows keep their human decision; "resolved" rows stay
   *   resolved (idempotent). Only open/claimed are touched.
   * - claimed_by/claimed_at survive on auto-resolved rows as history.
   * - Zero candidates (e.g. every vulnerability fixed since last run)
   *   resolves everything open/claimed for this repo.
   */
  private async resolveStaleMissions(
    tx: DbOrTx,
    repoId: string,
    processedMissionIds: string[],
  ): Promise<number> {
    const conditions = [
      eq(missions.repoId, repoId),
      inArray(missions.status, ["open", "claimed"] as const),
    ];
    // notInArray with an empty list would be invalid SQL — but an empty
    // processed set means there are no candidates at all, so the exclusion
    // simply doesn't apply: every open/claimed mission of the repo resolves.
    if (processedMissionIds.length > 0) {
      conditions.push(notInArray(missions.id, processedMissionIds));
    }

    const resolvedRows = await tx
      .update(missions)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(...conditions))
      .returning({ id: missions.id });

    return resolvedRows.length;
  }

  // ---------------------------------------------------------------------------
  // ADR 0042 — bulk mission writes (one round-trip each, replaces 2N)
  // ---------------------------------------------------------------------------

  /**
   * Bulk-insert every new mission and bulk-update every existing mission in
   * two round-trips, replacing the original per-row loop's 2N calls (one
   * insert-or-refresh + one mission_scores upsert per classification).
   *
   * The classification pass above has already done the per-row decision
   * (existing or new, with `reopen` set when an auto-resolved mission is
   * back among the candidates), so this method is purely a transport-layer
   * collapse: every row that needs writing goes in one statement; every
   * row that needs refreshing goes in another.
   *
   * `missions` deliberately has no unique constraint (AGENTS.md §11); the
   * "this is new" decision is made by the `existingMissions` lookup the
   * call site did before reaching here, so the bulk insert is safe within
   * the surrounding transaction. The bulk update is `UPDATE ... FROM
   * (VALUES ...)` so all rows in one statement.
   *
   * Returns the new-mission ids in input order, plus the created/updated
   * counts. A `null` slot in `newMissionIds` corresponds to an existing
   * mission (id lives in `row.existingMissionId`); the two arrays are
   * positional mirrors of the prepared rows.
   */
  private async bulkWriteMissions(
    tx: DbOrTx,
    prepared: {
      existingMissionId: string | null;
      reopen: boolean;
      missionInput: {
        repoId: string;
        dependencyId: string;
        advisoryId: string | null;
        title: string;
        description: string;
        actionHint: string | null;
        missionType: MissionType;
      };
    }[],
  ): Promise<{ newMissionIds: (string | null)[]; created: number; updated: number }> {
    const newMissionIds: (string | null)[] = prepared.map(() => null);
    let created = 0;
    let updated = 0;

    // ---- Bulk INSERT: one statement for every new mission ----
    const newRows = prepared
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.existingMissionId === null);

    if (newRows.length > 0) {
      const inserted = await tx
        .insert(missions)
        .values(
          newRows.map(({ row }) => ({
            repoId: row.missionInput.repoId,
            title: row.missionInput.title,
            description: row.missionInput.description,
            actionHint: row.missionInput.actionHint,
            missionType: row.missionInput.missionType,
            advisoryId: row.missionInput.advisoryId,
            dependencyId: row.missionInput.dependencyId,
          })),
        )
        .returning({ id: missions.id });

      if (inserted.length !== newRows.length) {
        throw new Error(
          `bulkWriteMissions: INSERT returned ${String(inserted.length)} ids, expected ${String(newRows.length)} — row-order alignment broken.`,
        );
      }

      for (let i = 0; i < newRows.length; i++) {
        const newRow = newRows[i];
        const insertedRow = inserted[i];
        if (newRow === undefined || insertedRow === undefined) continue;
        newMissionIds[newRow.index] = insertedRow.id;
      }
      created = newRows.length;
    }

    // ---- Bulk UPDATE: one statement for every existing mission ----
    const existingRows = prepared
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.existingMissionId !== null);

    if (existingRows.length > 0) {
      // The per-row reopen decision (ADR 0008 §3: only auto-"resolved"
      // missions may flip back to "open" when their pair comes back;
      // dismissed/claimed rows keep their human state) is captured at
      // prepare time as `row.reopen`. We pass it as an extra column in
      // the VALUES list and let the SET clause's CASE expression read it,
      // which keeps the SQL self-contained and avoids needing a
      // lateral join or a row-by-row decision at SQL time.
      //
      // `sql.param(value)` builds a parameterized chunk that Drizzle
      // renders as the next available `$N` placeholders (its internal
      // `paramStartIndex` counter auto-advances), so the assembled SQL
      // gets one positional parameter per scalar. Inline `::uuid` /
      // `::mission_type` casts run after the parameter substitution,
      // which Postgres accepts as the canonical typed-parameter form.
      const valuesClauses: ReturnType<typeof sql>[] = [];
      for (const { row } of existingRows) {
        valuesClauses.push(
          sql`(${sql.param(row.existingMissionId)}::uuid, ${sql.param(row.missionInput.title)}, ${sql.param(row.missionInput.description)}, ${sql.param(row.missionInput.actionHint)}, ${sql.param(row.missionInput.missionType)}::mission_type, ${sql.param(row.reopen)}::boolean)`,
        );
      }

      const valuesUnion = sql.join(valuesClauses, sql`, `);

      await tx.execute(
        sql`UPDATE missions SET
              title = v.title,
              description = v.description,
              action_hint = v.action_hint,
              mission_type = v.mission_type,
              status = CASE WHEN v.reopen THEN 'open'::mission_status ELSE missions.status END,
              resolved_at = CASE WHEN v.reopen THEN NULL ELSE missions.resolved_at END,
              updated_at = NOW()
            FROM (VALUES ${valuesUnion}) AS v(id, title, description, action_hint, mission_type, reopen)
            WHERE missions.id = v.id`,
      );
      updated = existingRows.length;
    }

    return { newMissionIds, created, updated };
  }

  /**
   * Bulk-upsert every mission_scores row in one statement.
   * mission_scores.missionId is unique (schema.ts), so `onConflictDoUpdate`
   * covers both the new (just-inserted missions) and existing paths.
   */
  private async bulkUpsertMissionScores(
    tx: DbOrTx,
    rows: { missionId: string | null; score: MissionScoreComputation }[],
  ): Promise<void> {
    const valid = rows.filter(
      (r): r is { missionId: string; score: MissionScoreComputation } => r.missionId !== null,
    );
    if (valid.length === 0) return;

    await tx
      .insert(missionScores)
      .values(
        valid.map(({ missionId, score }) => ({
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
        })),
      )
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
