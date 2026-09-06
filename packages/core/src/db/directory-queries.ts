/**
 * Repo directory and count queries
 *
 * Powers the home page (`/`) and org directory (`/org/[org]`) with
 * aggregated repo stats: indexed count, total count, skipped repos,
 * per-repo ecosystem badges, and per-severity mission counts.
 *
 * Lives in packages/core (not /app) for the same reason as queries.ts:
 * keeps every Drizzle query against schema.ts in one program/project context,
 * avoiding the cross-package type-identity issue from ADR 0012.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { dependencies, missions, organizations, repos, advisories } from "./schema.js";
import type { Ecosystem, Severity } from "./schema.js";
import type { ReadonlyDb } from "./queries.js";
import { getBookmarkedRepoIds } from "./bookmarks.js";
import { getSubscribedRepoIds } from "../notifications/subscriptions.js";
import {
  EMPTY_REPO_MISSION_COUNTS,
  type RepoMissionCounts,
  type RepoWithMissionSummary,
  type SkippedRepo,
} from "./query-types.js";

/** Count of repos that have completed at least one ingestion run. */
export async function getIndexedRepoCount(db: ReadonlyDb): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(repos)
    .where(eq(repos.ingestionStatus, "complete"));
  return rows[0]?.count ?? 0;
}

/**
 * Count of all submitted repos, regardless of ingestion status. This is
 * what the MVP repo cap actually limits — matches the count submitRepo()
 * checks server-side (packages/core/src/db/repos.ts). Distinct from
 * getIndexedRepoCount() above, which is the public-facing "successfully
 * processed" stat, not the submission cap.
 */
export async function getTotalRepoCount(db: ReadonlyDb): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(repos);
  return rows[0]?.count ?? 0;
}

/**
 * Repos whose most recent ingestion completed without error but found no
 * analyzable package.json/pyproject.toml/requirements.txt/go.mod (status:
 * "skipped" — see the ingestion_status enum's own comment in schema.ts).
 * Still counts against the repo cap via getTotalRepoCount() above; excluded
 * from getIndexedRepoCount() since nothing was actually indexed. Small
 * enough a list that the dashboard can show it in full — no pagination.
 */
export async function getSkippedRepos(db: ReadonlyDb): Promise<SkippedRepo[]> {
  return db
    .select({ owner: repos.owner, name: repos.name, reason: repos.ingestionError })
    .from(repos)
    .where(eq(repos.ingestionStatus, "skipped"));
}

/**
 * Combined header chrome the home page (`/`) and board page (`/missions`)
 * render alongside their main content: the public-facing "N repos indexed"
 * stat (only `status: 'complete'` repos), the "N repos submitted" stat
 * (the MVP cap's actual denominator, every submitted repo), and the
 * skipped-repo disclosure list.
 *
 * The two statements run in parallel (`Promise.all`) so callers see a single
 * round-trip pair instead of three sequential round-trips — the
 * consolidated form of what `/` and `/missions` used to do as three
 * separate cached reads (ADR 0046). Both queries ride the existing
 * `idx_repos_ingestion_status` index; at the current 150-repo cap each
 * is a sub-millisecond index scan, but the real win is the eliminated
 * HTTP round-trip + the single 60 s cached slot that replaces three.
 *
 * `getIndexedRepoCount` / `getTotalRepoCount` / `getSkippedRepos` remain
 * exported as thin wrappers for any direct caller that only needs one
 * slice; the canonical entry point is this function.
 */
export interface RepoDirectorySummary {
  /** Count of repos with `ingestion_status = 'complete'` — the "indexed" stat. */
  indexedCount: number;
  /** Count of every submitted repo — the MVP cap's denominator. */
  totalCount: number;
  /** Repos with `ingestion_status = 'skipped'`, with the ingestor's reason. */
  skippedRepos: SkippedRepo[];
}

export async function getRepoDirectorySummary(db: ReadonlyDb): Promise<RepoDirectorySummary> {
  const [counts, skippedRepos] = await Promise.all([
    db
      .select({
        indexedCount: sql<number>`count(*) filter (where ${repos.ingestionStatus} = 'complete')::int`,
        totalCount: sql<number>`count(*)::int`,
      })
      .from(repos),
    getSkippedRepos(db),
  ]);
  return {
    indexedCount: counts[0]?.indexedCount ?? 0,
    totalCount: counts[0]?.totalCount ?? 0,
    skippedRepos,
  };
}

/**
 * Distinct ecosystems present in one repo — same source data
 * getReposWithMissionSummary() uses for the directory grid, just scoped to
 * a single repo_id instead of grouped across all of them. Backs the
 * ecosystem badges on /repo/[owner]/[name]'s header.
 */
export async function getRepoEcosystems(db: ReadonlyDb, repoId: string): Promise<Ecosystem[]> {
  const rows = await db
    .selectDistinct({ ecosystem: dependencies.ecosystem })
    .from(dependencies)
    .where(eq(dependencies.repoId, repoId));
  return rows.map((row) => row.ecosystem);
}

/**
 * Options that scope the directory listing. `orgLogin` filters to repos
 * belonging to one organization (resolves to org_id internally; returns
 * an empty list if the login doesn't match any org). `userLogin` adds
 * per-viewer bookmark + subscription flags; omit it for an
 * anonymous/signed-out call and every row's flags are simply false.
 */
export interface RepoDirectoryOptions {
  orgLogin?: string;
  userLogin?: string;
}

/**
 * One row per repo for the directory page (ADR 0027) — mission counts by
 * severity and the set of ecosystems present, without shipping every
 * mission's full payload the way the fetch-everything queries above do.
 *
 * Deliberately four small, independently-bounded queries assembled in
 * application code rather than one mega-join: a single query joining
 * missions/advisories/dependencies against repos would multiply rows in
 * exactly the way this function exists to avoid. Every one of the four is
 * bounded by repo count (the MVP cap) or (repo x severity) pairs, not by
 * total mission count — matching the reasoning in this file's own header
 * comment about why these queries live in packages/core in the first
 * place: correctness and cost here matter more than a single round trip.
 *
 * isBookmarked / isSubscribed are only present when userLogin was passed;
 * they default to false otherwise (anonymous visit). The login-aware overlay
 * runs in this file because both flags come from the same data source and
 * had drifted between the core and /app implementations — keeping the
 * overlay here means a caller can't accidentally render stale
 * isBookmarked / hidden NotificationToggle just because they took the
 * un-overlaid code path.
 */
export async function getRepoDirectoryBase(
  db: ReadonlyDb,
  options: RepoDirectoryOptions = {},
): Promise<RepoWithMissionSummary[]> {
  const { orgLogin, userLogin } = options;

  // Resolve orgLogin -> orgId once. An unknown org is an empty directory,
  // not a thrown error — matches the pre-existing ByOrg behavior.
  let orgId: string | null = null;
  if (orgLogin !== undefined) {
    const org = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.githubLogin, orgLogin))
      .limit(1);
    orgId = org[0]?.id ?? null;
    if (orgId === null) return [];
  }

  const repoFilter = orgId === null ? undefined : eq(repos.orgId, orgId);
  const repoJoin = orgId === null ? undefined : eq(repos.orgId, orgId);

  const [repoRows, ecosystemRows, severityRows] = await Promise.all([
    repoFilter === undefined ? db.select().from(repos) : db.select().from(repos).where(repoFilter),
    repoJoin === undefined
      ? db
          .selectDistinct({ repoId: dependencies.repoId, ecosystem: dependencies.ecosystem })
          .from(dependencies)
      : db
          .selectDistinct({ repoId: dependencies.repoId, ecosystem: dependencies.ecosystem })
          .from(dependencies)
          .innerJoin(repos, eq(dependencies.repoId, repos.id))
          .where(repoJoin),
    // LEFT JOIN on advisories + COALESCE(advisories.severity, 'unknown')
    // (ADR 0053). Inner-joining advisories silently dropped every mission
    // with advisory_id = NULL (all dep_update / maintenance / license_issue
    // rows — schema.ts:269 makes advisory_id nullable with ON DELETE SET
    // NULL) from the home-page card's per-severity counts, and grouped
    // advisory.severity IS NULL rows under a SQL-NULL bucket that the JS
    // loop's counts[row.severity] coerced into a phantom counts["null"]
    // property no Severity literal reads. The same COALESCE expression
    // powers the board-wide BOARD_SEVERITY_EXPR (board-queries.ts) and the
    // per-repo Impact facet (via runBoardTally), so the directory's count
    // is now byte-identical to those instead of a silently-broken subset.
    repoJoin === undefined
      ? db
          .select({
            repoId: missions.repoId,
            severity: sql<string>`COALESCE(${advisories.severity}::text, 'unknown')`,
            count: sql<number>`count(*)::int`,
          })
          .from(missions)
          .leftJoin(advisories, eq(missions.advisoryId, advisories.id))
          .where(inArray(missions.status, ["open", "claimed"]))
          .groupBy(missions.repoId, sql<string>`COALESCE(${advisories.severity}::text, 'unknown')`)
      : db
          .select({
            repoId: missions.repoId,
            severity: sql<string>`COALESCE(${advisories.severity}::text, 'unknown')`,
            count: sql<number>`count(*)::int`,
          })
          .from(missions)
          .leftJoin(advisories, eq(missions.advisoryId, advisories.id))
          .innerJoin(repos, eq(missions.repoId, repos.id))
          .where(and(inArray(missions.status, ["open", "claimed"]), repoJoin))
          .groupBy(missions.repoId, sql<string>`COALESCE(${advisories.severity}::text, 'unknown')`),
  ]);

  const ecosystemsByRepo = new Map<string, Set<Ecosystem>>();
  for (const row of ecosystemRows) {
    const set = ecosystemsByRepo.get(row.repoId) ?? new Set<Ecosystem>();
    set.add(row.ecosystem);
    ecosystemsByRepo.set(row.repoId, set);
  }

  const countsByRepo = new Map<string, RepoMissionCounts>();
  // COALESCE on the SQL side (ADR 0053) guarantees row.severity is one of
  // the five Severity literals, but the loop's `counts[row.severity] +=`
  // would happily create a new property on `counts` if a future migration
  // introduces a new severity the JS-side Record<Severity, number> doesn't
  // know about yet. The Severity guard pins that contract: an unrecognized
  // value still gets added to counts.total (so the repo isn't silently
  // dropped from the directory's missionCount summary) but never invents
  // a phantom property. This is the same defensive pattern ADR 0053's fix
  // is the corollary of — the old code dropped rows; the post-fix code
  // would invent phantom buckets if the Severity enum drifted.
  const KNOWN_SEVERITIES: ReadonlySet<Severity> = new Set([
    "critical",
    "high",
    "medium",
    "low",
    "unknown",
  ]);
  for (const row of severityRows) {
    const counts = countsByRepo.get(row.repoId) ?? { ...EMPTY_REPO_MISSION_COUNTS };
    counts.total += row.count;
    if (KNOWN_SEVERITIES.has(row.severity as Severity)) {
      counts[row.severity as Severity] += row.count;
    }
    countsByRepo.set(row.repoId, counts);
  }

  // Login-aware overlay: both bookmark and subscription flags come from
  // the same per-user data source, so fetching them in parallel and
  // merging once keeps the directory's per-viewer shape consistent across
  // every entry point (board-wide listing, per-org page, future surfaces).
  let bookmarkedIds: Set<string> = new Set<string>();
  let subscribedIds: Set<string> = new Set<string>();
  if (userLogin !== undefined) {
    const [bookmarks, subscriptions] = await Promise.all([
      getBookmarkedRepoIds(db, userLogin),
      getSubscribedRepoIds(db, userLogin),
    ]);
    bookmarkedIds = bookmarks;
    subscribedIds = subscriptions;
  }

  return repoRows.map((repo) => {
    const isBookmarked = bookmarkedIds.has(repo.id);
    const isSubscribed = subscribedIds.has(repo.id);
    return {
      ...repo,
      ecosystems: Array.from(ecosystemsByRepo.get(repo.id) ?? []),
      missionCounts: countsByRepo.get(repo.id) ?? EMPTY_REPO_MISSION_COUNTS,
      isBookmarked,
      // isSubscribed is only meaningful when userLogin was passed. Setting
      // it to undefined for anonymous visitors lets the UI gate the
      // notification toggle on a presence check rather than always-false
      // (per ADR 0027's "false, not a tri-state" — except this field is
      // genuinely tri-state: it can be absent entirely).
      ...(userLogin !== undefined && { isSubscribed }),
    };
  });
}
