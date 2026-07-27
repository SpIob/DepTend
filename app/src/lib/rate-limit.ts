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
 */

type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export function createRateLimiter(
  limit: number,
  windowMs: number,
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
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }

    recent.push(now);
    hits.set(key, recent);
    return { allowed: true };
  };
}

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** POST /api/repos — mirrors spirit of existing repo cap, not a hard security boundary. */
export const checkRepoSubmissionLimit = createRateLimiter(5, HOUR_MS);

/** POST /api/missions/[id]/claim and .../unclaim — shared pool, same class of action. */
export const checkMissionActionLimit = createRateLimiter(20, MINUTE_MS);
