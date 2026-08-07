import { notFound } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  getBookmarkedRepoIds,
  getRepoByOwnerAndName,
  getRepoEcosystems,
  getRepoMissionsWithScores,
} from "@/lib/queries/missions";
import { MissionBoard } from "@/components/mission-board";
import { parseMissionBoardQuery } from "@/lib/mission-board-query";
import { AuthStatus } from "@/components/auth-status";
import { BookmarkToggle } from "@/components/bookmark-toggle";
import { WithdrawButton } from "@/components/withdraw-button";
import { EcosystemBadge } from "@/components/ecosystem-badge";
import { ingestionStatusNote } from "@/lib/ingestion-status";

// Next 15 can hand a param multiple values (`?severity=high&severity=low`);
// this board only ever writes a single comma-joined value, so the first one
// is the only shape it needs to understand on read.
function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export const dynamic = "force-dynamic";

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
 * Per-repo mission board (ADR 0027) — everything the old flat board did,
 * scoped to one repo via getRepoMissionsWithScores() instead of every
 * repo at once. Reuses MissionBoard/MissionFilterBar/MissionCard/search
 * completely unchanged — only the data source and the header differ from
 * /missions.
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

  const [missions, bookmarkedIds, ecosystems, rawParams] = await Promise.all([
    getRepoMissionsWithScores(repo.id),
    login === undefined ? Promise.resolve(new Set<string>()) : getBookmarkedRepoIds(login),
    getRepoEcosystems(repo.id),
    searchParams,
  ]);

  const initialQuery = parseMissionBoardQuery({
    q: firstValue(rawParams.q),
    severity: firstValue(rawParams.severity),
    ecosystem: firstValue(rawParams.ecosystem),
    effort: firstValue(rawParams.effort),
    sort: firstValue(rawParams.sort),
    group: firstValue(rawParams.group),
  });

  const statusNote = ingestionStatusNote(repo.ingestionStatus);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-border flex flex-col gap-5 border-b pb-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" className="flex shrink-0 items-center gap-2">
              <span className="bg-accent inline-block h-2.5 w-2.5" aria-hidden="true" />
              <span className="text-ink font-mono text-xl font-bold tracking-tight">
                deptend.dev
              </span>
            </Link>
            <span className="text-border" aria-hidden="true">
              /
            </span>
            <h1 className="text-ink min-w-0 truncate font-mono text-sm font-semibold">
              {repo.owner}/{repo.name}
            </h1>
            <BookmarkToggle repoId={repo.id} initialBookmarked={bookmarkedIds.has(repo.id)} />
          </div>
          <div className="text-ink-muted flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
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
          </div>
        </div>
        {ecosystems.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {ecosystems.map((ecosystem) => (
              <EcosystemBadge key={ecosystem} ecosystem={ecosystem} />
            ))}
          </div>
        )}
        <p className="text-ink-muted max-w-xl text-sm leading-relaxed">
          {repo.description ?? "Prioritized maintenance missions for this repo."}
        </p>
        <Link
          href="/"
          className="text-accent hover:text-ink w-fit font-mono text-xs underline decoration-dotted underline-offset-2"
        >
          ← All repos
        </Link>
      </header>

      {statusNote !== null ? (
        <>
          <EmptyState note={statusNote} />
          <WithdrawButton
            repoId={repo.id}
            submittedBy={repo.submittedBy}
            ingestionStatus={repo.ingestionStatus}
          />
        </>
      ) : missions.length === 0 ? (
        <EmptyState note={null} />
      ) : (
        <MissionBoard missions={missions} initialQuery={initialQuery} showGroupByRepo={false} />
      )}
    </main>
  );
}
