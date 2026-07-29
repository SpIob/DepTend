import Link from "next/link";
import { getBoardMissions, getIndexedRepoCount, getSkippedRepos } from "@/lib/queries/missions";
import { MissionBoard } from "@/components/mission-board";
import { parseMissionBoardQuery } from "@/lib/mission-board-query";
import { AuthStatus } from "@/components/auth-status";

// Next 15 can hand a param multiple values (`?severity=high&severity=low`);
// this board only ever writes a single comma-joined value, so the first one
// is the only shape it needs to understand on read.
function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Live data on every request, same reasoning as the repo directory (page.tsx).
export const dynamic = "force-dynamic";

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
 * instead of drilling into one repo at a time; costs nothing to keep
 * since nothing about MissionBoard/MissionFilterBar/MissionCard changed —
 * they still just render whatever mission array they're handed.
 */
export default async function AllMissionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const [missions, repoCount, skippedRepos, rawParams] = await Promise.all([
    getBoardMissions(),
    getIndexedRepoCount(),
    getSkippedRepos(),
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

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="border-border flex flex-col gap-5 border-b pb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2">
              <span className="bg-accent inline-block h-2.5 w-2.5" aria-hidden="true" />
              <span className="text-ink font-mono text-xl font-bold tracking-tight">
                deptend.dev
              </span>
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

      {missions.length === 0 ? (
        <EmptyState />
      ) : (
        <MissionBoard missions={missions} initialQuery={initialQuery} />
      )}
    </main>
  );
}
