/**
 * GITHUB_TOKEN warning — shared pipeline module
 *
 * Single source of truth for the unauthenticated GitHub API warning message
 * and log function. Used by both scripts/ingest.js and cli/src/index.ts.
 *
 * Promote to a shared module only if a third caller appears — see
 * cli/src/index.ts:132-134 for the original comment.
 */

export const GITHUB_TOKEN_WARNING =
  "GH_INGEST_TOKEN is not set. GitHub API calls will be unauthenticated " +
  "(60 req/hr limit). Set GH_INGEST_TOKEN to raise the limit to 5,000 req/hr.";

export function logGithubTokenWarning(logFn: (level: string, message: string) => void): void {
  logFn("warn", GITHUB_TOKEN_WARNING);
}
