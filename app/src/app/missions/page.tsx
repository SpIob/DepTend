import Link from "next/link";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { Suspense } from "react";
import {
  getRepoDirectorySummary,
  getBoardMissionsPage,
  BOARD_PAGE_SIZE,
  type BoardFilters,
} from "@/lib/queries/missions";
import { PaginatedMissionBoard } from "@/components/paginated-mission-board";
import {
  parseAndValidateBoardQuery,
  buildBoardFilters,
  getEffectivePage,
  hasActiveFilters,
} from "@/lib/mission-board-server";
import { AuthStatus } from "@/components/auth-status";
import { BrandMark } from "@/components/brand-mark";
import { PageHeader } from "@/components/page-header";
import { REQUEST_ID_HEADER } from "@/lib/timing/store";
import { logTimingsForRequest } from "@/lib/timing/log";
import type { MissionBoardQuery } from "@/lib/mission-board-query";

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
 * Round 3 of the 2026-09-05 perf series moved the data fetches and the
 * data-dependent render into a single async Server Component, then wrapped
 * that component in a <Suspense> boundary. The motivation is in
 * reports/perf/2026-09-05/round-3/summary.md — the LCP text on this page
 * was being delivered as part of the streaming subtree, so it didn't paint
 * until after React's $RS() swap (≈500-700ms of element render delay in
 * Lighthouse). Rendering the LCP <p> outside the boundary, with only the
 * data-dependent parts suspended, lets the browser paint the LCP text
 * from the first HTML payload, ahead of JS hydration.
 *
 * The skeleton for the board below is intentionally narrower than the old
 * missions/loading.tsx: the LCP text is no longer a placeholder, only the
 * board's data-dependent area is.
 */
function BoardSkeleton(): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-3" aria-label="Loading missions">
      {(["mission-0", "mission-1", "mission-2", "mission-3"] as const).map((key) => (
        <li key={key} className="border-border bg-surface h-24 animate-pulse rounded-md border" />
      ))}
    </ul>
  );
}

function HeaderRightSkeleton(): React.JSX.Element {
  // Reserves the layout slot for the "N repos indexed | M skipped" pair so
  // the surrounding header chrome (AuthStatus etc.) doesn't shift when the
  // real values stream in. Same height as the resolved content.
  return (
    <>
      <span className="bg-surface inline-block h-3 w-20 animate-pulse rounded" />
    </>
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
 *
 * Since round 3 of the 2026-09-05 perf series (reports/perf/2026-09-05/),
 * the LCP <p> in the header is rendered outside the <Suspense> boundary so
 * it streams in with the initial HTML payload instead of being part of the
 * suspended subtree. The data-dependent header stats and the board itself
 * are inside the boundary, with a narrow skeleton that doesn't cover the
 * LCP text.
 *
 * Per-segment timing (ADR 0052 follow-up) is lifted to the query layer via
 * `withTiming()` in `lib/queries/missions.ts`. The middleware emits a
 * `Server-Timing: total;dur=...` header for the full request duration.
 */
export default async function AllMissionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const reqId = (await headers()).get(REQUEST_ID_HEADER) ?? "no-req-id";
  const startedAt = Date.now();
  const result = await renderAllMissionsPage(searchParams);
  const totalMs = Date.now() - startedAt;
  logTimingsForRequest("/missions", totalMs, reqId);
  return result;
}

async function renderAllMissionsPage(
  searchParams: Promise<Record<string, string | string[] | undefined>>,
): Promise<React.JSX.Element> {
  const query = await parseAndValidateBoardQuery(searchParams, "/missions");
  const filters = buildBoardFilters(query);

  return (
    <main id="main" className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <PageHeader
        left={
          <>
            <BrandMark href="/" />
            <span className="text-border" aria-hidden="true">
              /
            </span>
            <h1 className="text-ink-muted font-mono text-sm">all missions</h1>
          </>
        }
        right={
          <>
            {/* Data-driven header stats (count + skipped) stream in via
                the same Suspense boundary as the board. The skeleton's
                width matches the resolved text so the surrounding flex
                row doesn't shift. AuthStatus is always visible. */}
            <Suspense fallback={<HeaderRightSkeleton />}>
              <DataDrivenHeaderStats />
            </Suspense>
            <span className="text-border" aria-hidden="true">
              |
            </span>
            <AuthStatus />
          </>
        }
      >
        {/* LCP element. Renders immediately with the initial HTML payload,
            outside the <Suspense> boundary — see reports/perf/2026-09-05/round-3
            for the LCP render-delay root cause this addresses. */}
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
      </PageHeader>

      <Suspense fallback={<BoardSkeleton />}>
        <BoardArea filters={filters} page={query.page} initialQuery={query} />
      </Suspense>
    </main>
  );
}

async function DataDrivenHeaderStats(): Promise<React.JSX.Element> {
  const { indexedCount, skippedRepos } = await getRepoDirectorySummary();
  return (
    <>
      <span>
        {indexedCount} {indexedCount === 1 ? "repo" : "repos"} indexed
      </span>
      {skippedRepos.length > 0 && (
        <>
          <span className="text-border" aria-hidden="true">
            |
          </span>
          <span>{skippedRepos.length} skipped</span>
        </>
      )}
    </>
  );
}

async function BoardArea({
  filters,
  page,
  initialQuery,
}: {
  filters: BoardFilters;
  page: number;
  initialQuery: MissionBoardQuery;
}): Promise<React.JSX.Element> {
  const board = await getBoardMissionsPage(filters, page);

  const pageCount = Math.max(1, Math.ceil(board.total / BOARD_PAGE_SIZE));
  const effectivePage = getEffectivePage(page, board.total, BOARD_PAGE_SIZE);

  if (board.total === 0 && !hasActiveFilters(initialQuery)) {
    return <EmptyState />;
  }

  return (
    <PaginatedMissionBoard
      missions={board.missions}
      total={board.total}
      facets={board.facets}
      pageSize={BOARD_PAGE_SIZE}
      page={effectivePage}
      pageCount={pageCount}
      initialQuery={initialQuery}
      basePath="/missions"
    />
  );
}
