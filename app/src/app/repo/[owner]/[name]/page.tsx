import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  getBookmarkedRepoIds,
  getRepoBoardPage,
  getRepoByOwnerAndName,
  getRepoEcosystems,
  type BoardFilters,
} from "@/lib/queries/missions";
import { PaginatedMissionBoard } from "@/components/paginated-mission-board";
import { buildMissionBoardHref, parseMissionBoardQuery } from "@/lib/mission-board-query";
import { AuthStatus } from "@/components/auth-status";
import { BookmarkToggle } from "@/components/bookmark-toggle";
import { WithdrawButton } from "@/components/withdraw-button";
import { EcosystemBadge } from "@/components/ecosystem-badge";
import { BrandMark } from "@/components/brand-mark";
import { PageHeader } from "@/components/page-header";
import { firstSearchParamValue } from "@/lib/search-params";
import { ingestionStatusNote } from "@/lib/ingestion-status";

export const dynamic = "force-dynamic";

// Title from route params only — no DB read, so a not-yet-ingested or
// mistyped repo still gets a correct browser-tab title on its 404.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ owner: string; name: string }>;
}): Promise<Metadata> {
  const { owner, name } = await params;
  return { title: `${owner}/${name}` };
}

function EmptyState({ note }: { note: string | null }): React.JSX.Element {
  return (
    <div className="border-border bg-surface rounded-sm border border-dashed p-10 text-center">
      <p className="text-ink font-medium">No open missions for this repo.</p>
      <p className="text-ink-muted mt-1 text-sm">
        {note ?? "Either it's in good shape, or it hasn't finished ingesting yet."}
      </p>
    </div>
  );
}

/**
 * Per-repo mission board (ADR 0027, ADR 0041). The same
 * PaginatedMissionBoard the board-wide /missions listing uses, scoped to
 * one repo via getRepoBoardPage(). pageSize is the returned mission count
 * and pageCount is hard-coded to 1 so the pagination UI never renders.
 * One repo's mission list fits on one page in practice. showGroupByRepo
 * is forced off because every row is already one repo.
 */
export default async function RepoPage({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { owner, name } = await params;
  const repo = await getRepoByOwnerAndName(owner, name);
  if (repo === null) {
    notFound();
  }

  const session = await getServerSession(authOptions);
  const login = session?.user?.login;

  const rawParams = await searchParams;
  const initialQuery = parseMissionBoardQuery({
    q: firstSearchParamValue(rawParams.q),
    severity: firstSearchParamValue(rawParams.severity),
    ecosystem: firstSearchParamValue(rawParams.ecosystem),
    effort: firstSearchParamValue(rawParams.effort),
    missionType: firstSearchParamValue(rawParams.missionType),
    sort: firstSearchParamValue(rawParams.sort),
    group: firstSearchParamValue(rawParams.group),
  });

  const filters: BoardFilters = {
    q: initialQuery.q,
    severities: Array.from(initialQuery.severity),
    ecosystems: Array.from(initialQuery.ecosystem),
    efforts: Array.from(initialQuery.effort),
    missionTypes: Array.from(initialQuery.missionType),
    sort: initialQuery.sort,
  };

  const [board, bookmarkedIds, ecosystems] = await Promise.all([
    // Per-repo caller passes a non-default limit so a single repo with more
    // missions than BOARD_PAGE_SIZE doesn't silently truncate the user's
    // list at 50. The per-repo page suppresses pagination (pageSize =
    // board.missions.length, pageCount = 1) so the result is rendered whole.
    // ADR 0031's pagination is unaffected on /missions.
    getRepoBoardPage(repo.id, filters, { limit: 1000 }),
    login === undefined ? Promise.resolve(new Set<string>()) : getBookmarkedRepoIds(login),
    getRepoEcosystems(repo.id),
  ]);

  const statusNote = ingestionStatusNote(repo.ingestionStatus);

  return (
    <main id="main" className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <PageHeader
        left={
          <>
            <BrandMark href="/" />
            <span className="text-border" aria-hidden="true">
              /
            </span>
            <h1 className="text-ink min-w-0 truncate font-mono text-sm font-semibold">
              {repo.owner}/{repo.name}
            </h1>
            <BookmarkToggle repoId={repo.id} initialBookmarked={bookmarkedIds.has(repo.id)} />
          </>
        }
        right={
          <>
            <a
              href={`https://github.com/${repo.owner}/${repo.name}`}
              className="hover:text-ink underline decoration-dotted underline-offset-2"
            >
              View on GitHub
            </a>
            <span className="text-border" aria-hidden="true">
              |
            </span>
            <AuthStatus />
          </>
        }
      >
        {ecosystems.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {ecosystems.map((ecosystem) => (
              <EcosystemBadge key={ecosystem} ecosystem={ecosystem} />
            ))}
          </div>
        )}
        {/* Same stats the repo card shows on the directory, mirrored here —
            on their own line so the title row never truncates to fit them. */}
        <div className="text-ink-muted flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
          <span>★ {repo.stars.toLocaleString()}</span>
          {repo.lastIngestedAt !== null && (
            <span>Ingested {repo.lastIngestedAt.toLocaleDateString()}</span>
          )}
        </div>
        <p className="text-ink-muted max-w-xl text-sm leading-relaxed">
          {repo.description ?? "Prioritized maintenance missions for this repo."}
        </p>
        <Link
          href="/"
          className="text-accent hover:text-ink w-fit font-mono text-xs underline decoration-dotted underline-offset-2"
        >
          ← All repos
        </Link>
      </PageHeader>

      {statusNote !== null ? (
        <>
          <EmptyState note={statusNote} />
          <WithdrawButton
            repoId={repo.id}
            submittedBy={repo.submittedBy}
            ingestionStatus={repo.ingestionStatus}
          />
        </>
      ) : board.missions.length === 0 &&
        filters.q.trim() === "" &&
        filters.severities.length === 0 &&
        filters.ecosystems.length === 0 &&
        filters.efforts.length === 0 &&
        filters.missionTypes.length === 0 ? (
        // No active filter and no missions at all. Show the "repo in
        // good shape" message. A filter zero-out falls through to
        // PaginatedMissionBoard, which renders its own
        // "No missions match these filters" empty state.
        <EmptyState note={null} />
      ) : (
        <PaginatedMissionBoard
          missions={board.missions}
          total={board.total}
          facets={board.facets}
          pageSize={board.missions.length}
          page={1}
          pageCount={1}
          initialQuery={initialQuery}
          basePath={buildMissionBoardHref(`/repo/${repo.owner}/${repo.name}`, {})}
          showGroupByRepo={false}
        />
      )}
    </main>
  );
}
