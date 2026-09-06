import { getRepoDirectorySummary } from "@/lib/queries/missions";
import { SubmitRepoForm } from "@/components/submit-repo-form";
import { BrandMark } from "@/components/brand-mark";
import { PageHeader } from "@/components/page-header";
import Link from "next/link";

export const dynamic = "force-dynamic";

const RAW_MAX_REPOS = Number.parseInt(process.env.NEXT_PUBLIC_MAX_REPOS ?? "150", 10);
const MAX_REPOS: number = Number.isFinite(RAW_MAX_REPOS) && RAW_MAX_REPOS > 0 ? RAW_MAX_REPOS : 150;

export default async function SubmitPage(): Promise<React.JSX.Element> {
  const { totalCount: totalRepoCount } = await getRepoDirectorySummary();

  return (
    <main id="main" className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <PageHeader
        left={<BrandMark />}
        right={
          <>
            <Link
              href="/"
              className="hover:text-ink underline decoration-dotted underline-offset-2"
            >
              ← All repos
            </Link>
            <span className="text-border" aria-hidden="true">
              |
            </span>
            <Link
              href="/missions"
              className="hover:text-ink underline decoration-dotted underline-offset-2"
            >
              Browse all missions
            </Link>
          </>
        }
      >
        <h1 className="text-ink text-2xl font-semibold">Submit a repository</h1>
        <p className="text-ink-muted max-w-2xl text-sm leading-relaxed">
          Add a public GitHub repository to DepTend. We'll scan its dependencies against the OSV
          vulnerability database and generate a prioritized list of maintenance missions.
        </p>
        <SubmitRepoForm repoCount={totalRepoCount} maxRepos={MAX_REPOS} />
      </PageHeader>
    </main>
  );
}
