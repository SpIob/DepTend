import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRepoDirectorySummary, getReposWithMissionSummary } from "@/lib/queries/missions";
import { AuthStatus } from "@/components/auth-status";
import { SubmitRepoForm } from "@/components/submit-repo-form";
import { RepoCard } from "@/components/repo-card";
import { BrandMark } from "@/components/brand-mark";
import type { RepoWithMissionSummary } from "@deptend/core";

// This page reads live data from Neon on every request — repo/mission
// state changes as ingestion runs complete and bookmarks are toggled, so
// baking a snapshot in at build time would show stale results. Also means
// `next build` never needs a DB connection.
export const dynamic = "force-dynamic";

// Defaults to 150; falls through to the same value on a non-numeric env
// (a deploy with NEXT_PUBLIC_MAX_REPOS=banana would otherwise silently
// disable the cap check below, since `count >= NaN` is always false).
const RAW_MAX_REPOS = Number.parseInt(process.env.NEXT_PUBLIC_MAX_REPOS ?? "150", 10);
const MAX_REPOS: number = Number.isFinite(RAW_MAX_REPOS) && RAW_MAX_REPOS > 0 ? RAW_MAX_REPOS : 150;

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

  const [repos, { totalCount: totalRepoCount, skippedRepos }] = await Promise.all([
    getReposWithMissionSummary(login),
    getRepoDirectorySummary(),
  ]);

  // Derived from the same fetch, not a second query — getIndexedRepoCount()
  // would just recompute what's already sitting in `repos`.
  const indexedCount = repos.filter((repo) => repo.ingestionStatus === "complete").length;
  const sorted = [...repos].sort(compareRepos);

  return (
    <main id="main" className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-border flex flex-col gap-5 border-b pb-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <BrandMark />
          </div>
          <div className="text-ink-muted flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
            <span>
              {indexedCount} {indexedCount === 1 ? "repo" : "repos"} indexed
            </span>
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

      {skippedRepos.length > 0 && (
        // Skipped repos used to live as an inline <details> wedged into the
        // auth-status flex row. Its popover floated over the auth button
        // on narrow screens and read identically to a normal link. Moved
        // it to a section below the grid so the disclosure has a
        // consistent home, the heading is announced, and the header
        // strip stays one coherent line.
        <section
          aria-labelledby="skipped-repos-heading"
          className="border-border bg-surface rounded-sm border border-dashed p-5"
        >
          <details className="group/skipped">
            <summary className="text-ink-muted hover:text-ink flex cursor-pointer items-center gap-2 font-mono text-xs">
              <span
                aria-hidden="true"
                className="shrink-0 transition-transform group-open/skipped:rotate-90"
              >
                ▸
              </span>
              <span id="skipped-repos-heading" className="text-ink font-medium">
                {skippedRepos.length} skipped
              </span>
              <span>(repos with no analyzable manifest)</span>
            </summary>
            <ul className="text-ink-muted mt-3 flex flex-col gap-1 font-mono text-xs">
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
        </section>
      )}
    </main>
  );
}
