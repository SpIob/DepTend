import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  getReposWithMissionSummary,
  getSkippedRepos,
  getTotalRepoCount,
} from "@/lib/queries/missions";
import { AuthStatus } from "@/components/auth-status";
import { SubmitRepoForm } from "@/components/submit-repo-form";
import { RepoCard } from "@/components/repo-card";
import type { RepoWithMissionSummary } from "@deptend/core";

// This page reads live data from Neon on every request — repo/mission
// state changes as ingestion runs complete and bookmarks are toggled, so
// baking a snapshot in at build time would show stale results. Also means
// `next build` never needs a DB connection.
export const dynamic = "force-dynamic";

const MAX_REPOS = Number.parseInt(process.env.NEXT_PUBLIC_MAX_REPOS ?? "10", 10);

function EmptyState(): React.JSX.Element {
  return (
    <div className="border-border bg-surface rounded-sm border border-dashed p-10 text-center">
      <p className="text-ink font-medium">No repos indexed yet.</p>
      <p className="text-ink-muted mt-1 text-sm">
        Submit a public GitHub repo above to get started.
      </p>
    </div>
  );
}

// Bookmarked repos surface first; among the rest, the neediest repo (most
// open+claimed missions) leads — same "what to fix next" framing the
// mission board itself uses, just one level up. owner/name is the final,
// deterministic tie-break.
function compareRepos(a: RepoWithMissionSummary, b: RepoWithMissionSummary): number {
  if (a.isBookmarked !== b.isBookmarked) {
    return a.isBookmarked ? -1 : 1;
  }
  if (a.missionCounts.total !== b.missionCounts.total) {
    return b.missionCounts.total - a.missionCounts.total;
  }
  return `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`);
}

/**
 * Repo directory (ADR 0027) — the default landing page as of this ADR,
 * replacing the flat cross-repo mission board (still at /missions,
 * unchanged). Scan repos here, drill into one at /repo/[owner]/[name] for
 * its full ranked mission list — bounds both the query and the payload by
 * one repo's mission count instead of the whole board's.
 */
export default async function RepoDirectoryPage(): Promise<React.JSX.Element> {
  const session = await getServerSession(authOptions);
  const login = session?.user?.login;

  const [repos, totalRepoCount, skippedRepos] = await Promise.all([
    getReposWithMissionSummary(login),
    getTotalRepoCount(),
    getSkippedRepos(),
  ]);

  // Derived from the same fetch, not a second query — getIndexedRepoCount()
  // would just recompute what's already sitting in `repos`.
  const indexedCount = repos.filter((repo) => repo.ingestionStatus === "complete").length;
  const sorted = [...repos].sort(compareRepos);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-border flex flex-col gap-5 border-b pb-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <span className="bg-accent inline-block h-2.5 w-2.5" aria-hidden="true" />
            <h1 className="text-ink font-mono text-xl font-bold tracking-tight">deptend.dev</h1>
          </div>
          <div className="text-ink-muted flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
            <span>
              {indexedCount} {indexedCount === 1 ? "repo" : "repos"} indexed
            </span>
            {skippedRepos.length > 0 && (
              <>
                <span className="text-border" aria-hidden="true">
                  |
                </span>
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
            <span className="text-border" aria-hidden="true">
              |
            </span>
            <Link
              href="/missions"
              className="hover:text-ink underline decoration-dotted underline-offset-2"
            >
              Browse all missions
            </Link>
            <span className="text-border" aria-hidden="true">
              |
            </span>
            <AuthStatus />
          </div>
        </div>
        <p className="text-ink-muted max-w-2xl text-sm leading-relaxed">
          Every indexed repo, with its highest-priority missions summarized. Open a repo for the
          full ranked list — every score shows its work, expand any mission for the inputs and
          weights behind it.
        </p>
        <SubmitRepoForm repoCount={totalRepoCount} maxRepos={MAX_REPOS} />
      </header>

      {sorted.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sorted.map((repo) => (
            <li key={repo.id}>
              <RepoCard repo={repo} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
