/**
 * GitHub organization metadata fetcher
 *
 * Fetches a GitHub org's public profile fields (login, name, avatar) from
 * `GET /orgs/{org}`. Used to populate the local `organizations` table so
 * the per-org directory route (`/org/[org]`) has data to render — without
 * this, the route falls through to the parent loading.tsx and serves an
 * empty skeleton indefinitely (per-repo rows exist but their `org_id` is
 * NULL because the ingestion pipeline historically only pulled dependency
 * data, not GitHub-side org metadata).
 *
 * One fetch per ingested repo, in parallel with the existing
 * `fetchGitHubRepoMeta` call (ADR 0027 / Phase 1 architecture). Free-tier
 * GitHub rate budget covers the addition: a 5,000 req/hr authenticated
 * token (env `GITHUB_TOKEN`) comfortably absorbs it, and even the
 * unauthenticated 60 req/hr ceiling doesn't materially change since the
 * pipeline already does one repo-meta call per repo.
 *
 * User-owned repos (a personal GitHub account, not an org) hit `/orgs/{login}`
 * with a 404 — that's fine and expected. For those, `lookupGitHubOwnerMeta`
 * falls back to `GET /users/{login}` and treats the row as a person-shaped
 * org: `name` from the user's display name, `avatarUrl` from the avatar
 * URL. The `organizations` table holds both kinds uniformly; the org page
 * just shows whichever row is there.
 *
 * No auth required for public orgs/users, but `GITHUB_TOKEN` raises the
 * rate limit from 60 to 5,000 req/hr — same rationale as every other
 * GitHub call here.
 */

import { fetchJson } from "./fetch-json.js";
import type { FetchRetryOptions } from "./fetch-retry.js";

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "deptend.dev/0.1.0 (https://github.com/deptend/deptend.dev)";

/** Minimal shape we use from either `/orgs/{org}` or `/users/{user}`. */
export interface GitHubOwnerMeta {
  login: string;
  /** Display name; for users this is `name`, for orgs the org's display name. */
  name: string | null;
  /** Avatar URL. */
  avatarUrl: string | null;
  /** Whether the row is an org (true) or a user (false). */
  isOrg: boolean;
}

/**
 * The two failure kinds callers branch on. Everything else stays a plain
 * Error — only these carry structured `kind` data so downstream code never
 * has to match on message text.
 *
 * - "not_found": 404 — neither an org nor a user with that login exists
 *   (deleted account, typo), or the org endpoint was queried for a user
 *   that exists. The caller may have already fallen back from /orgs to
 *   /users, so this kind is the final-not-found case.
 * - "rate_limited": 403/429 — the shared GitHub API budget ran out.
 */
export type GitHubOrgMetaFailureKind = "not_found" | "rate_limited";

export class GitHubOrgMetaError extends Error {
  readonly kind: GitHubOrgMetaFailureKind;

  constructor(kind: GitHubOrgMetaFailureKind, message: string) {
    super(message);
    this.name = "GitHubOrgMetaError";
    this.kind = kind;
  }
}

function buildAuthHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function isNotFoundStatus(status: number): boolean {
  return status === 404;
}

function isRateLimitedStatus(status: number): boolean {
  return status === 403 || status === 429;
}

/**
 * Classify a GitHub API response. Throws a GitHubOrgMetaError for the
 * two branch-worthy cases (`not_found` on 404, `rate_limited` on
 * 403/429) and returns undefined to let fetchJson's default-error path
 * handle anything else (network failures, parse failures, 5xx).
 *
 * The 404 case throws `not_found` here even though a personal account
 * is technically a valid 404-to-user fallthrough — the lookup function
 * catches that error and only re-throws it if BOTH endpoints 404.
 * Throwing on the first 404 (instead of returning a string and letting
 * fetchJson throw a generic Error) is what preserves the typed-error
 * `instanceof GitHubOrgMetaError` check in the calling code.
 */
function classifyOrgStatus(login: string): (response: Response) => string | undefined {
  return (response: Response): string | undefined => {
    if (isNotFoundStatus(response.status)) {
      throw new GitHubOrgMetaError(
        "not_found",
        `GitHub login not found: ${login}. ` +
          `It may be deleted, suspended, or the URL may be incorrect.`,
      );
    }
    if (isRateLimitedStatus(response.status)) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = response.headers.get("x-ratelimit-reset");
      const resetTime = reset ? new Date(Number(reset) * 1000).toISOString() : "unknown";
      throw new GitHubOrgMetaError(
        "rate_limited",
        `GitHub API rate limit hit (HTTP ${String(response.status)}). ` +
          `Remaining: ${remaining ?? "unknown"}. Resets at: ${resetTime}. ` +
          `Set GITHUB_TOKEN to raise the limit to 5,000 req/hr.`,
      );
    }
    return undefined;
  };
}

interface OrgResponseBody {
  login: string;
  name?: string | null;
  avatar_url?: string | null;
}

interface UserResponseBody {
  login: string;
  name?: string | null;
  avatar_url?: string | null;
}

/**
 * Look up the public profile for a repo's owner (a GitHub login) — org if
 * one exists, user otherwise. Returns a uniform `GitHubOwnerMeta` either
 * way so the writer can upsert the same row shape into `organizations`.
 *
 * Free-tier-safe: one `/orgs` call, one `/users` call only if the first
 * 404s. A deleted account (both endpoints 404) is a hard not_found.
 *
 * @param login - GitHub login (org or username)
 * @param token - GitHub token, or null for unauthenticated (60 req/hr)
 * @param options - transport tuning passed straight to fetchJson
 * @throws GitHubOrgMetaError when the login doesn't resolve to either an
 *   org or a user, or when the rate limit is hit
 */
export async function lookupGitHubOwnerMeta(
  login: string,
  token: string | null,
  options?: FetchRetryOptions,
): Promise<GitHubOwnerMeta> {
  const orgUrl = `${GITHUB_API_BASE}/orgs/${encodeURIComponent(login)}`;
  const headers = buildAuthHeaders(token);

  try {
    const orgBody = await fetchJson<OrgResponseBody>(
      orgUrl,
      { headers },
      {
        ...(options !== undefined ? { fetchOptions: options } : {}),
        classifyStatus: classifyOrgStatus(login),
      },
    );
    return {
      login: orgBody.login,
      name: orgBody.name ?? null,
      avatarUrl: orgBody.avatar_url ?? null,
      isOrg: true,
    };
  } catch (err) {
    // The classifier throws GitHubOrgMetaError(kind=not_found) for a
    // /orgs 404 — that means "this login isn't an org" (most likely a
    // personal account) and we want to fall through to /users. A
    // rate_limited GitHubOrgMetaError, or any other error, is fatal.
    if (err instanceof GitHubOrgMetaError && err.kind === "not_found") {
      // fall through to /users
    } else {
      throw err;
    }
  }

  const userUrl = `${GITHUB_API_BASE}/users/${encodeURIComponent(login)}`;
  try {
    const userBody = await fetchJson<UserResponseBody>(
      userUrl,
      { headers },
      {
        ...(options !== undefined ? { fetchOptions: options } : {}),
        classifyStatus: classifyOrgStatus(login),
      },
    );
    return {
      login: userBody.login,
      name: userBody.name ?? null,
      avatarUrl: userBody.avatar_url ?? null,
      isOrg: false,
    };
  } catch (err) {
    // If the user-endpoint also 404s, the login simply doesn't exist —
    // surface a not_found. A rate_limited or other error is fatal.
    if (err instanceof GitHubOrgMetaError && err.kind === "not_found") {
      throw new GitHubOrgMetaError(
        "not_found",
        `GitHub login not found: ${login}. ` +
          `It may be deleted, suspended, or the URL may be incorrect.`,
      );
    }
    throw err;
  }
}
