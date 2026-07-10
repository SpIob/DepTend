/**
 * Triggers the ingest.yml workflow_dispatch event on deptend.dev's own
 * GitHub repo (not the submitted target repo) so a freshly submitted repo
 * doesn't have to wait for the next 04:00 UTC cron run.
 *
 * Needs a GitHub PAT with `actions: write` scope on this repo — GH_TOKEN
 * is the auto-injected Actions token (only valid inside a workflow run,
 * not usable from Vercel), so this is a separate, new secret:
 * GH_DISPATCH_TOKEN. GH_REPO identifies which repo to dispatch against
 * ("owner/name" — deptend.dev's own repo, not configurable per-request).
 *
 * Best-effort: if this fails, the repo row is still created and the daily
 * cron will pick it up regardless — see submitRepo() in
 * packages/core/src/db/repos.ts.
 */

export interface DispatchResult {
  ok: boolean;
  error?: string;
}

export async function triggerIngestion(repoId: string): Promise<DispatchResult> {
  const token = process.env.GH_DISPATCH_TOKEN;
  const repoSlug = process.env.GH_REPO;

  if (token === undefined || token === "" || repoSlug === undefined || repoSlug === "") {
    return { ok: false, error: "GH_DISPATCH_TOKEN or GH_REPO is not configured." };
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repoSlug}/actions/workflows/ingest.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: { repo_id: repoId, triggered_by: "submit" },
        }),
      },
    );

    if (!response.ok) {
      return { ok: false, error: `GitHub API returned ${response.status.toString()}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}
