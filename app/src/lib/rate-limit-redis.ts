/**
 * Redis-backed rate limiting using Upstash.
 *
 * Replaces the in-memory rate limiter (ADR 0025) with a distributed
 * rate limiter that persists across serverless instances and cold starts.
 *
 * Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment
 * variables. Falls back to in-memory limiter if not configured (for local dev).
 *
 * ADR: docs/adr/0025-rate-limiting-in-memory.md (superseded)
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

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

let redisClient: Redis | null = null;
let repoSubmissionLimiter: Ratelimit | ReturnType<typeof createRateLimiter> = createRateLimiter(
  5,
  60 * 60 * 1000,
  "repo-submission",
);
let missionActionLimiter: Ratelimit | ReturnType<typeof createRateLimiter> = createRateLimiter(
  20,
  60 * 1000,
  "mission-action",
);

function getRedisClient(): Redis | null {
  if (redisClient) return redisClient;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.warn(
      "[rate-limit] UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set — " +
        "falling back to in-memory rate limiter (not suitable for production)",
    );
    return null;
  }

  try {
    redisClient = new Redis({ url, token });
    return redisClient;
  } catch (err) {
    console.error("[rate-limit] Failed to initialize Upstash Redis client:", err);
    return null;
  }
}

function initializeLimiters(): void {
  const redis = getRedisClient();

  if (redis) {
    repoSubmissionLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(5, "1 h"),
      prefix: "ratelimit:repo-submission",
      analytics: true,
    });

    missionActionLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(20, "1 m"),
      prefix: "ratelimit:mission-action",
      analytics: true,
    });

    console.warn("[rate-limit] Upstash Redis rate limiters initialized");
  } else {
    repoSubmissionLimiter = createRateLimiter(5, 60 * 60 * 1000, "repo-submission");
    missionActionLimiter = createRateLimiter(20, 60 * 1000, "mission-action");
    console.warn("[rate-limit] In-memory rate limiters initialized (fallback)");
  }
}

// Initialize on module load
initializeLimiters();

/**
 * Check rate limit for repo submission (5 per hour per login).
 * Uses Upstash Redis if configured, otherwise in-memory fallback.
 */
export async function checkRepoSubmissionLimit(login: string): Promise<RateLimitResult> {
  if (repoSubmissionLimiter instanceof Ratelimit === false) {
    // In-memory fallback (synchronous)
    return Promise.resolve(repoSubmissionLimiter(login));
  }
  const result = await repoSubmissionLimiter.limit(login);
  if (result.success) {
    return { allowed: true };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.ceil((result.reset - Date.now()) / 1000),
  };
}

/**
 * Check rate limit for mission actions (20 per minute per login).
 * Shared pool for claim/unclaim/bookmark/unbookmark.
 * Uses Upstash Redis if configured, otherwise in-memory fallback.
 */
export async function checkMissionActionLimit(login: string): Promise<RateLimitResult> {
  if (missionActionLimiter instanceof Ratelimit === false) {
    // In-memory fallback (synchronous)
    return Promise.resolve(missionActionLimiter(login));
  }
  const result = await missionActionLimiter.limit(login);
  if (result.success) {
    return { allowed: true };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.ceil((result.reset - Date.now()) / 1000),
  };
}
