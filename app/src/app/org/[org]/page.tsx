import { notFound } from "next/navigation";
import Image from "next/image";
import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  getOrganizationByLogin,
  getUserOrganizations,
  getReposByOrg,
} from "@/lib/queries/organizations";
import { RepoCard } from "@/components/repo-card";
import { AuthStatus } from "@/components/auth-status";
import { BrandMark } from "@/components/brand-mark";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ org: string }>;
}): Promise<Metadata> {
  const { org } = await params;
  return { title: `Organization: ${org}` };
}

export default async function OrgPage({
  params,
}: {
  params: Promise<{ org: string }>;
}): Promise<React.JSX.Element> {
  const { org: orgLogin } = await params;
  const session = await getServerSession(authOptions);
  const login = session?.user?.login;

  const [org, userOrgs, repos] = await Promise.all([
    getOrganizationByLogin(orgLogin),
    login ? getUserOrganizations(login) : Promise.resolve([]),
    getReposByOrg(orgLogin, login),
  ]);

  if (org === null) {
    notFound();
  }

  const isMember = userOrgs.some((o) => o.githubLogin === orgLogin);

  return (
    <main id="main" className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-border flex flex-col gap-5 border-b pb-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <BrandMark href="/" />
            <span className="text-border" aria-hidden="true">
              /
            </span>
            <h1 className="text-ink font-mono text-lg font-semibold">{org.name ?? orgLogin}</h1>
            {org.avatarUrl && (
              <Image
                src={org.avatarUrl}
                alt=""
                width={32}
                height={32}
                loading="lazy"
                decoding="async"
                // Drop the previous no-op `bg-bg` (backgrounds sit behind
                // an <img>'s pixels, not around them). The 1px border
                // still needs *some* surface when the asset has not
                // loaded, so use `bg-surface` underneath.
                className="border-border shrink-0 rounded-full border"
              />
            )}
          </div>
          <div className="text-ink-muted flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
            {isMember && (
              <span className="bg-accent/10 text-accent border-accent/20 rounded-sm border px-2 py-0.5">
                Member
              </span>
            )}
            <AuthStatus />
          </div>
        </div>
        <p className="text-ink-muted max-w-2xl text-sm leading-relaxed">
          Repositories in this organization.
        </p>
      </header>

      {repos.length === 0 ? (
        <div className="border-border bg-surface rounded-sm border border-dashed p-10 text-center">
          <p className="text-ink font-medium">No repositories in this organization.</p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {repos.map((repo) => (
            <li key={repo.id}>
              <RepoCard repo={repo} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
