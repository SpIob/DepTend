/**
 * Repo bookmarks — save/unsave a repo for quicker access (ADR 0027).
 *
 * Lives here, not in /app, for the same reason repos.ts, missions.ts, and
 * queries.ts do (see queries.ts's own header) — keeps every Drizzle query
 * against schema.ts in one program/project context, avoiding the
 * cross-package type-identity issue from ADR 0012.
 *
 * bookmarkRepo() checks repo existence up front rather than letting a bad
 * ID surface as a foreign-key violation — a caught FK error would be a
 * raw Postgres error, not a clean, distinguishable outcome the API route
 * can map to a 404 (same shape submitRepo() already uses for its own
 * existence check). unbookmarkRepo() is a single guarded DELETE...WHERE,
 * same reasoning claimMission()/unclaimMission() use: no transaction
 * needed (neon-http doesn't support db.transaction() — ADR 0009; a single
 * guarded statement is already atomic on its own), and "never bookmarked"
 * / "repo doesn't exist" collapse into one outcome, since the caller's
 * remedy is identical either way — nothing to remove.
 */

import { and, eq } from "drizzle-orm";
import { repoBookmarks, repos } from "./schema.js";
import type { ReadonlyDb } from "./queries.js";

export type BookmarkRepoOutcome = "bookmarked" | "already_bookmarked" | "not_found";

/** Bookmarks repoId on behalf of userLogin (a GitHub login). Idempotent. */
export async function bookmarkRepo(
  db: ReadonlyDb,
  repoId: string,
  userLogin: string,
): Promise<BookmarkRepoOutcome> {
  const [repo] = await db.select({ id: repos.id }).from(repos).where(eq(repos.id, repoId)).limit(1);

  if (repo === undefined) {
    return "not_found";
  }

  const [inserted] = await db
    .insert(repoBookmarks)
    .values({ repoId, userLogin })
    .onConflictDoNothing({ target: [repoBookmarks.userLogin, repoBookmarks.repoId] })
    .returning({ id: repoBookmarks.id });

  return inserted === undefined ? "already_bookmarked" : "bookmarked";
}

export type UnbookmarkRepoOutcome = "unbookmarked" | "not_bookmarked";

/** Releases userLogin's bookmark on repoId, if any. */
export async function unbookmarkRepo(
  db: ReadonlyDb,
  repoId: string,
  userLogin: string,
): Promise<UnbookmarkRepoOutcome> {
  const [deleted] = await db
    .delete(repoBookmarks)
    .where(and(eq(repoBookmarks.repoId, repoId), eq(repoBookmarks.userLogin, userLogin)))
    .returning({ id: repoBookmarks.id });

  return deleted === undefined ? "not_bookmarked" : "unbookmarked";
}

/**
 * Repo IDs bookmarked by userLogin, as a Set for cheap membership checks.
 * Backs both the repo directory's isBookmarked flag (queries.ts) and the
 * per-repo page's bookmark toggle — one query, no per-repo round trip.
 */
export async function getBookmarkedRepoIds(
  db: ReadonlyDb,
  userLogin: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ repoId: repoBookmarks.repoId })
    .from(repoBookmarks)
    .where(eq(repoBookmarks.userLogin, userLogin));
  return new Set(rows.map((row) => row.repoId));
}
