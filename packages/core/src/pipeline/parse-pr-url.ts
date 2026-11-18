/**
 * Pull-request URL parser — sibling of parse-github-url.ts (ADR 0066).
 *
 * Extracted so the mission PR-link write path (ADR 0068) validates the
 * exact URL shape it stores at the route boundary, rather than accepting
 * any string. Deliberately strict: only https GitHub pull-request URLs
 * (issue #42's contract — "URL validated as a GitHub PR URL").
 */

const PR_PATTERN = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;

export interface ParsedPullRequestUrl {
  /** Normalized URL stored on the mission (trailing slash stripped). */
  url: string;
  owner: string;
  name: string;
  number: number;
}

/**
 * Parses a GitHub pull-request URL (https://github.com/owner/name/pull/N).
 * Accepts an optional trailing slash; rejects every other host, path
 * shape, and non-numeric PR number. Returns null for anything else —
 * callers treat null as "invalid input", never as a different URL kind.
 */
export function parsePullRequestUrl(raw: string): ParsedPullRequestUrl | null {
  const candidate = raw.trim().replace(/\/+$/, "");
  const match = PR_PATTERN.exec(candidate);
  if (match === null) {
    return null;
  }
  return {
    url: candidate,
    owner: match[1] ?? "",
    name: match[2] ?? "",
    number: Number.parseInt(match[3] ?? "", 10),
  };
}
