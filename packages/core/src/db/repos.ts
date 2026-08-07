/**
 * Repo submission
 *
 * Lives here, not in /app, for the same reason getOpenMissionsWithScores
 * does (see queries.ts's header) — keeps every Drizzle query in one
 * program/project context, avoiding the cross-package type-identity issue
 * from ADR 0012.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { repos, type Repo } from "./schema.js";
import type { ReadonlyDb } from "./queries.js";

export interface ParsedGithubUrl {
  /** Normalized form: https://github.com/{owner}/{name}, no trailing slash or .git */
  githubUrl: string;
  owner: string;
  name: string;
}

const GITHUB_URL_PATTERN =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\/([a-zA-Z0-9._-]+?)(?:\.git)?\/?$/;

/**
 * Parses and normalizes a submitted GitHub repo URL. Accepts with or
 * without protocol/www/trailing slash/.git suffix. Returns null for
 * anything that isn't a plausible github.com owner/repo URL — including
 * non-GitHub hosts, which is intentional (only public repos may be
 * ingested — see project plan §6.4 data & privacy).
 */
export function parseGithubUrl(input: string): ParsedGithubUrl | null {
  const match = GITHUB_URL_PATTERN.exec(input.trim());
  if (match === null) {
    return null;
  }
  const [, owner, name] = match;
  if (owner === undefined || name === undefined) {
    return null;
  }
  return { githubUrl: `https://github.com/${owner}/${name}`, owner, name };
}

/**
 * Resolves a repo by its (owner, name) pair — the shape /repo/[owner]/[name]
 * (ADR 0027) is addressed by, matching the existing repos_owner_name_unique
 * constraint. Returns null rather than throwing so the page can render a
 * clean 404 instead of an unhandled error.
 */
export async function getRepoByOwnerAndName(
  db: ReadonlyDb,
  owner: string,
  name: string,
): Promise<Repo | null> {
  const [repo] = await db
    .select()
    .from(repos)
    .where(and(eq(repos.owner, owner), eq(repos.name, name)))
    .limit(1);
  return repo ?? null;
}

export type SubmitRepoOutcome = "created" | "already_exists" | "cap_reached";

export interface SubmitRepoResult {
  outcome: SubmitRepoOutcome;
  repo: Repo | null;
}

export interface SubmitRepoParams {
  githubUrl: string;
  owner: string;
  name: string;
  /** GitHub login of the submitter — stamped onto repos.submitted_by. */
  submittedBy: string;
  maxRepos: number;
}

/**
 * Inserts a new repo row (status: pending) if there's room under the MVP
 * cap and it isn't already submitted.
 *
 * Known, accepted limitation: the cap check (count, then insert) is two
 * queries, not one atomic statement — a race between two submissions
 * arriving in the same instant could let the count exceed maxRepos by one.
 * Not fixed with a transaction (neon-http doesn't support one — ADR 0009)
 * or a single guarded INSERT...SELECT (Drizzle's insert-from-select
 * builder doesn't have a clean shape for "literal values, no source
 * table, WHERE-guarded" — the raw-SQL alternative was judged not worth
 * the deviation from this project's established Drizzle-query-API-only
 * convention for what is, in practice, a single-operator MVP with no
 * concurrent traffic). The same-URL race (two submissions of the same
 * repo) is handled correctly via onConflictDoNothing below.
 */
export async function submitRepo(
  db: ReadonlyDb,
  params: SubmitRepoParams,
): Promise<SubmitRepoResult> {
  const existing = await db
    .select()
    .from(repos)
    .where(eq(repos.githubUrl, params.githubUrl))
    .limit(1);

  if (existing.length > 0) {
    return { outcome: "already_exists", repo: existing[0] ?? null };
  }

  const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(repos);
  const count = countRows[0]?.count ?? 0;
  if (count >= params.maxRepos) {
    return { outcome: "cap_reached", repo: null };
  }

  const [inserted] = await db
    .insert(repos)
    .values({
      githubUrl: params.githubUrl,
      owner: params.owner,
      name: params.name,
      submittedBy: params.submittedBy,
    })
    .onConflictDoNothing({ target: repos.githubUrl })
    .returning();

  if (inserted === undefined) {
    // Lost a race against a concurrent submission of the same URL between
    // the existence check above and this insert.
    const [raceWinner] = await db
      .select()
      .from(repos)
      .where(eq(repos.githubUrl, params.githubUrl))
      .limit(1);
    return { outcome: "already_exists", repo: raceWinner ?? null };
  }

  return { outcome: "created", repo: inserted };
}

export type WithdrawRepoOutcome =
  "withdrawn" | "not_found" | "not_your_submission" | "already_indexed";

/**
 * Deletes a repo the caller submitted themselves — but only while it's
 * still unindexed ("pending" or "skipped"). Once a repo reaches "complete"
 * it may carry real missions other people can see or claim, and is no
 * longer just "their" submission to walk back; "running" is deliberately
 * excluded too, to avoid deleting a row out from under an in-flight
 * ingestion job. A "failed" repo is left to resolvePending()'s existing
 * automatic retry rather than added here (Roadmap Now #4, Option B).
 *
 * Same shape as unclaimMission()/unbookmarkRepo(): a single guarded
 * DELETE...WHERE (no transaction needed — neon-http doesn't support one,
 * ADR 0009, and a single guarded statement is already atomic), with a
 * follow-up SELECT only when the delete matches zero rows, to distinguish
 * "doesn't exist" from "exists but isn't yours / isn't withdrawable" —
 * the same distinction unclaimMission() draws for not_claimed_by_you.
 */
export async function withdrawOwnRepo(
  db: ReadonlyDb,
  repoId: string,
  requestingUser: string,
): Promise<WithdrawRepoOutcome> {
  const [deleted] = await db
    .delete(repos)
    .where(
      and(
        eq(repos.id, repoId),
        eq(repos.submittedBy, requestingUser),
        inArray(repos.ingestionStatus, ["pending", "skipped"]),
      ),
    )
    .returning({ id: repos.id });

  if (deleted !== undefined) {
    return "withdrawn";
  }

  const [existing] = await db
    .select({ submittedBy: repos.submittedBy })
    .from(repos)
    .where(eq(repos.id, repoId))
    .limit(1);

  if (existing === undefined) {
    return "not_found";
  }
  return existing.submittedBy === requestingUser ? "already_indexed" : "not_your_submission";
}
