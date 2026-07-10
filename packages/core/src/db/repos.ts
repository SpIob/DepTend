/**
 * Repo submission
 *
 * Lives here, not in /app, for the same reason getOpenMissionsWithScores
 * does (see queries.ts's header) — keeps every Drizzle query in one
 * program/project context, avoiding the cross-package type-identity issue
 * from ADR 0012.
 */

import { eq, sql } from "drizzle-orm";
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
