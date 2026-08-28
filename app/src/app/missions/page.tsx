import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  getBoardMissionsPage,
  getIndexedRepoCount,
  getSkippedRepos,
  BOARD_PAGE_SIZE,
  type BoardFilters,
} from "@/lib/queries/missions";
import { PaginatedMissionBoard } from "@/components/paginated-mission-board";
import { buildMissionBoardHref, parseMissionBoardQuery } from "@/lib/mission-board-query";
import { AuthStatus } from "@/components/auth-status";

// Next 15 can hand a param multiple values (`?severity=high&severity=low`);
// this board only ever writes a single comma-joined value, so the first one
// is the only shape it needs to understand on read.
function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Live data on every request, same reasoning as the repo directory (page.tsx).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "All missions",
};

function EmptyState(): React.JSX.Element {
  return (
    <div className="border-border bg-surface rounded-sm border border-dashed p-10 text-center">
      <p className="text-ink font-medium">No missions yet.</p>
      <p className="text-ink-muted mt-1 text-sm">
        Missions appear here once a submitted repo has been ingested and scored.
      </p>
    </div>
  );
}

/**
 * Every open/claimed mission across every indexed repo, one flat list —
 * what "/" rendered before ADR 0027 moved the default landing page to a
 * repo directory. Kept here for anyone who wants a single cross-repo feed
 * instead of drilling into one repo at a time.
 *
 * Since ADR 0031 this page is server-filtered and paginated: filters, sort,
 * and page number all live in the URL, drive SQL-side LIMIT/OFFSET in
 * packages/core/src/db/queries.ts, and come back down as at most
 * BOARD_PAGE_SIZE full missions plus facet counts — instead of the whole
 * board's payload the old client-side-filtered version shipped.
 */
export default async function AllMissionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const rawParams = await searchParams;
  const query = parseMissionBoardQuery({
    q: firstValue(rawParams.q),
    severity: firstValue(rawParams.severity),
    ecosystem: firstValue(rawParams.ecosystem),
    effort: firstValue(rawParams.effort),
    missionType: firstValue(rawParams.missionType),
    sort: firstValue(rawParams.sort),
    group: firstValue(rawParams.group),
    page: firstValue(rawParams.page),
  });

  const filters: BoardFilters = {
    q: query.q,
    severities: Array.from(query.severity),
    ecosystems: Array.from(query.ecosystem),
    efforts: Array.from(query.effort),
    missionTypes: Array.from(query.missionType),
    sort: query.sort,
  };

  // Repo count and skipped list only feed the header stats; they don't
  // depend on the board's filters, so all three reads run together.
  const [board, repoCount, skippedRepos] = await Promise.all([
    getBoardMissionsPage(filters, query.page),
    getIndexedRepoCount(),
    getSkippedRepos(),
  ]);

  // Canonicalize an out-of-range page (deep link past the end, or a filter
  // change that shrank the result set under a stale ?page=) instead of
  // rendering a blank page with no way forward.
  const pageCount = Math.max(1, Math.ceil(board.total / BOARD_PAGE_SIZE));
  if (query.page > pageCount) {
    redirect(buildMissionBoardHref("/missions", { ...query, page: pageCount }));
  }

  const hasFilters =
    query.severity.size > 0 ||
    query.ecosystem.size > 0 ||
    query.effort.size > 0 ||
    query.q.trim() !== "";

  return (
    <main id="main" className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-border flex flex-col gap-5 border-b pb-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" className="flex items-center gap-2">
              <span className="bg-accent inline-block h-2.5 w-2.5" aria-hidden="true" />
              <span className="text-ink font-mono text-xl font-bold tracking-tight">DepTend</span>
            </Link>
            <span className="text-border" aria-hidden="true">
              /
            </span>
            <h1 className="text-ink-muted font-mono text-sm">all missions</h1>
          </div>
          <div className="text-ink-muted flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
            <span>
              {repoCount} {repoCount === 1 ? "repo" : "repos"} indexed
            </span>
            {skippedRepos.length > 0 && (
              <>
                <span className="text-border" aria-hidden="true">
                  |
                </span>
                <span>{skippedRepos.length} skipped</span>
              </>
            )}
            <span className="text-border" aria-hidden="true">
              |
            </span>
            <AuthStatus />
          </div>
        </div>
        <p className="text-ink-muted max-w-xl text-sm leading-relaxed">
          Every open mission across every indexed repo, one list. Looking for one repo?{" "}
          <Link
            href="/"
            className="text-accent hover:text-ink underline decoration-dotted underline-offset-2"
          >
            Browse repos
          </Link>{" "}
          instead.
        </p>
      </header>

      {board.total === 0 && !hasFilters ? (
        <EmptyState />
      ) : (
        <PaginatedMissionBoard
          missions={board.missions}
          total={board.total}
          facets={board.facets}
          pageSize={BOARD_PAGE_SIZE}
          page={query.page}
          pageCount={pageCount}
          initialQuery={query}
          basePath="/missions"
        />
      )}
    </main>
  );
}
