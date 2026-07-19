/**
 * GitHub repo metadata fetcher
 *
 * Fetches a repository's metadata (stars, open issues, description, topics,
 * etc.) from the GitHub REST API. This is the source of the `stars` and
 * `open_issues_count` inputs EcosystemValueScorer needs — extracted from
 * scripts/ingest.js (where it originally lived as an untyped, unexported
 * local function) so it has exactly one implementation shared by the
 * ingestion pipeline and the Phase 4 CLI, rather than a copy in each.
 *
 * No auth required for public repos, but GITHUB_TOKEN raises the rate limit
 * from 60 req/hr to 5,000 req/hr — same rationale as every other GitHub API
 * call in this project.
 *
 * This is a faithful extraction, not a redesign: behavior (including error
 * messages) is unchanged from the original scripts/ingest.js version. No new
 * runtime validation was added on the response shape — the GitHub REST API's
 * contract is trusted the same way it always has been here.
 */

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "deptend.dev/0.1.0 (https://github.com/deptend/deptend.dev)";

/** Minimal shape we care about from GitHub's GET /repos/{owner}/{repo} response. */
export interface GitHubRepoMeta {
  full_name: string;
  name: string;
  owner: {
    login: string;
  };
  default_branch: string;
  description: string | null;
  stargazers_count: number;
  open_issues_count: number;
  topics?: string[];
  homepage: string | null;
}

/**
 * Fetch repository metadata from the GitHub REST API.
 *
 * @param owner - repo owner/org login
 * @param name - repo name
 * @param token - GitHub token for the 5,000 req/hr authenticated rate limit,
 *   or null for unauthenticated (60 req/hr)
 * @throws if the repo doesn't exist (404), the rate limit is hit (403/429),
 *   any other non-OK response, or a network-level failure
 */
export async function fetchGitHubRepoMeta(
  owner: string,
  name: string,
  token: string | null,
): Promise<GitHubRepoMeta> {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (err) {
    throw new Error(`Network error calling GitHub API for ${owner}/${name}: ${String(err)}`);
  }

  if (response.status === 404) {
    throw new Error(
      `GitHub repo not found: ${owner}/${name}. ` +
        `It may be private, deleted, or the URL may be incorrect.`,
    );
  }

  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    const resetTime = reset ? new Date(Number(reset) * 1000).toISOString() : "unknown";
    throw new Error(
      `GitHub API rate limit hit (HTTP ${String(response.status)}). ` +
        `Remaining: ${remaining ?? "unknown"}. Resets at: ${resetTime}. ` +
        `Set GITHUB_TOKEN to raise the limit to 5,000 req/hr.`,
    );
  }

  if (!response.ok) {
    throw new Error(`GitHub API returned HTTP ${String(response.status)} for ${owner}/${name}`);
  }

  return response.json() as Promise<GitHubRepoMeta>;
}
