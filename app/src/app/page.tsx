import {
  getBoardMissions,
  getIndexedRepoCount,
  getSkippedRepos,
  getTotalRepoCount,
} from "@/lib/queries/missions";
import { MissionBoard } from "@/components/mission-board";
import { parseMissionBoardQuery } from "@/lib/mission-board-query";
import { AuthStatus } from "@/components/auth-status";
import { SubmitRepoForm } from "@/components/submit-repo-form";

// Next 15 can hand a param multiple values (`?severity=high&severity=low`);
// this board only ever writes a single comma-joined value, so the first one
// is the only shape it needs to understand on read.
function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// This page reads live data from Neon on every request — missions change
// as ingestion runs complete, so baking a snapshot in at build time would
// show stale results. Also means `next build` never needs a DB connection.
export const dynamic = "force-dynamic";

const MAX_REPOS = Number.parseInt(process.env.NEXT_PUBLIC_MAX_REPOS ?? "10", 10);

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

export default async function MissionListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const [missions, repoCount, totalRepoCount, skippedRepos, rawParams] = await Promise.all([
    getBoardMissions(),
    getIndexedRepoCount(),
    getTotalRepoCount(),
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
      <header className="border-border flex flex-col gap-4 border-b pb-6">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-ink font-mono text-lg font-bold tracking-tight">deptend.dev</h1>
          <div className="flex items-center gap-4">
            <span className="text-ink-muted font-mono text-xs">
              {repoCount} {repoCount === 1 ? "repo" : "repos"} indexed
              {skippedRepos.length > 0 && (
                <>
                  {" · "}
                  <details className="inline">
                    <summary className="hover:text-ink inline cursor-pointer underline decoration-dotted underline-offset-2">
                      {skippedRepos.length} skipped
                    </summary>
                    <ul className="text-ink-muted mt-2 flex flex-col gap-1 text-left font-mono text-xs">
                      {skippedRepos.map((repo) => (
                        <li key={`${repo.owner}/${repo.name}`}>
                          <span className="text-ink">
                            {repo.owner}/{repo.name}
                          </span>{" "}
                          — {repo.reason ?? "no package.json found"}
                        </li>
                      ))}
                    </ul>
                  </details>
                </>
              )}
            </span>
            <AuthStatus />
          </div>
        </div>
        <p className="text-ink-muted text-sm">
          Prioritized maintenance missions, ranked by impact and ecosystem value, effort as the
          tie-breaker. Every score shows its work — expand any mission for the inputs and weights
          behind it.
        </p>
        <SubmitRepoForm repoCount={totalRepoCount} maxRepos={MAX_REPOS} />
      </header>

      {missions.length === 0 ? (
        <EmptyState />
      ) : (
        <MissionBoard missions={missions} initialQuery={initialQuery} />
      )}
    </main>
  );
}
