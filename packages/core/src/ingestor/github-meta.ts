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
 * Originally a faithful extraction from scripts/ingest.js — error messages
 * are still byte-identical to that version. Since then it gained the shared
 * transient-failure retry (fetch-retry.ts) and GitHubMetaError, whose `kind`
 * field lets callers classify the two branch-worthy failures structurally
 * instead of matching on message prefixes. No runtime validation is done on
 * the response shape — the GitHub REST API's contract is trusted the same
 * way it always has been here.
 */

import { fetchJson } from "./fetch-json.js";
import type { FetchRetryOptions } from "./fetch-retry.js";

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
 * The two failure kinds callers actually branch on. Everything else stays a
 * plain Error — only these carry structured kind data so downstream
 * classification never has to match on message text again.
 *
 * - "not_found": 404 — private, deleted, or mistyped URL.
 * - "rate_limited": 403/429 — the shared GitHub API budget ran out.
 */
export type GitHubMetaFailureKind = "not_found" | "rate_limited";

export class GitHubMetaError extends Error {
  readonly kind: GitHubMetaFailureKind;

  constructor(kind: GitHubMetaFailureKind, message: string) {
    super(message);
    this.name = "GitHubMetaError";
    this.kind = kind;
  }
}

/**
 * Builds the raw.githubusercontent.com base URL for a repo, percent-encoding
 * every path segment.
 *
 * Owner and repo name are charset-validated long before they reach here
 * (parseGithubUrl's GITHUB_URL_PATTERN), so their encoding is a no-op
 * formality — the segment that actually needs it is the branch ref. Git
 * permits `%` inside refnames (unlike `..`, `~`, `^` etc.), and
 * raw.githubusercontent.com URL-decodes each path segment server-side, so
 * an unencoded branch like `x%2F..%2Fother` would be silently re-interpreted
 * as `x/../other` on their end — pointing the manifest probe at a different
 * path than the one the repo's own settings named. Encoding here means a
 * literal-percent refname survives as itself and nothing attacker-chosen in
 * a repo's default_branch setting can change which files get fetched.
 *
 * Branch refs may legitimately contain `/` (feature branches), so encoding
 * is per-slash-separated-segment, never on the whole string.
 */
export function buildRawContentBase(owner: string, name: string, branch: string): string {
  const encodeSegments = (value: string): string =>
    value
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  return `https://raw.githubusercontent.com/${encodeSegments(owner)}/${encodeSegments(name)}/${encodeSegments(branch)}`;
}

/**
 * Fetch repository metadata from the GitHub REST API.
 *
 * Routed through the shared transient-failure retry policy (one retry,
 * capped Retry-After, per-attempt deadline), so a single flaky request no
 * longer fails a whole ingestion run or repo submission outright.
 *
 * @param owner - repo owner/org login
 * @param name - repo name
 * @param token - GitHub token for the 5,000 req/hr authenticated rate limit,
 *   or null for unauthenticated (60 req/hr)
 * @param options - transport tuning passed straight to fetchWithRetry.
 *   Background ingestion keeps the defaults; interactive callers
 *   (manifest-check.ts's submission pre-check) tighten them so a retry
 *   backoff can't stall a user-facing request.
 * @throws GitHubMetaError when the repo doesn't exist (404, kind
 *   "not_found") or the rate limit is hit (403/429, kind "rate_limited");
 *   plain Error on network-level failure or any other non-OK response.
 */
export async function fetchGitHubRepoMeta(
  owner: string,
  name: string,
  token: string | null,
  options?: FetchRetryOptions,
): Promise<GitHubRepoMeta> {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // Translate 404 → "not_found" and 403/429 → "rate_limited" into
  // GitHubMetaError before the generic HTTP error path. Other non-OK
  // responses (and network errors / parse failures) fall through to
  // the helper's default Error message.
  return fetchJson<GitHubRepoMeta>(
    url,
    { headers },
    {
      ...(options !== undefined ? { fetchOptions: options } : {}),
      errorPrefix: `GitHub API for ${owner}/${name}`,
      classifyStatus: (response) => {
        if (response.status === 404) {
          throw new GitHubMetaError(
            "not_found",
            `GitHub repo not found: ${owner}/${name}. ` +
              `It may be private, deleted, or the URL may be incorrect.`,
          );
        }
        if (response.status === 403 || response.status === 429) {
          const remaining = response.headers.get("x-ratelimit-remaining");
          const reset = response.headers.get("x-ratelimit-reset");
          const resetTime = reset ? new Date(Number(reset) * 1000).toISOString() : "unknown";
          throw new GitHubMetaError(
            "rate_limited",
            `GitHub API rate limit hit (HTTP ${String(response.status)}). ` +
              `Remaining: ${remaining ?? "unknown"}. Resets at: ${resetTime}. ` +
              `Set GITHUB_TOKEN to raise the limit to 5,000 req/hr.`,
          );
        }
        return undefined;
      },
    },
  );
}
