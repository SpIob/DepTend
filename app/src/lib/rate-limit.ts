/**
 * In-memory, per-serverless-instance rate limiting.
 *
 * Not correct across concurrently-warm serverless instances, and state
 * resets on cold start / redeploy. Deliberate zero-budget, zero-new-account
 * trade-off (decision point, 2026-07-27) over a Redis-backed limiter —
 * good enough to stop one abusive session hammering an endpoint, not a
 * defense against a distributed attacker. Revisit with Upstash
 * (@upstash/ratelimit) if that stops being an acceptable trade-off.
 *
 * All three gated routes (repo submission, claim, unclaim) already require
 * a GitHub OAuth session, so callers key on the authenticated `login`, not
 * IP — avoids x-forwarded-for parsing and shared-IP false positives.
 *
 * Logging (added 2026-08-06, see ADR 0025 addendum): every block logs a
 * single `console.warn` line — label, key, limit/window, retryAfterSeconds.
 * No new dependency, no new account: Vercel captures `console.warn` in its
 * function logs for free. This doesn't fix the known cross-instance gap,
 * it just makes it observable during launch week instead of invisible.
 * Allowed requests are not logged — that path is the hot path and would
 * dominate the logs for no diagnostic benefit.
 */

type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export function createRateLimiter(
  limit: number,
  windowMs: number,
  label = "rate-limit",
): (key: string) => RateLimitResult {
  const hits = new Map<string, number[]>();

  return function check(key: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - windowMs;
    const recent = (hits.get(key) ?? []).filter((timestamp) => timestamp > windowStart);

    if (recent.length >= limit) {
      hits.set(key, recent);
      const oldest = recent[0];
      const retryAfterMs = oldest === undefined ? windowMs : oldest + windowMs - now;
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      console.warn(
        `[rate-limit] blocked label=${label} key=${key} limit=${String(limit)}/${String(windowMs)}ms retryAfterSeconds=${String(retryAfterSeconds)}`,
      );
      return { allowed: false, retryAfterSeconds };
    }

    recent.push(now);
    hits.set(key, recent);
    return { allowed: true };
  };
}

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** POST /api/repos — mirrors spirit of existing repo cap, not a hard security boundary. */
export const checkRepoSubmissionLimit = createRateLimiter(5, HOUR_MS, "repo-submission");

/** POST /api/missions/[id]/claim, .../unclaim, and repo bookmark/unbookmark — shared pool, same class of action. */
export const checkMissionActionLimit = createRateLimiter(20, MINUTE_MS, "mission-action");
