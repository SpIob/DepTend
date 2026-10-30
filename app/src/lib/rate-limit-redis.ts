/**
 * Redis-backed rate limiting using Upstash.
 *
 * Replaces the in-memory rate limiter (ADR 0025) with a distributed
 * rate limiter that persists across serverless instances and cold starts.
 *
 * Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment
 * variables. Falls back to in-memory limiter if not configured (for local dev).
 *
 * Initialization is lazy on purpose — see app/src/lib/db.ts::getDb() for the
 * full reasoning. `next build` evaluates every route module even for
 * force-dynamic pages, so resolving the backend at module load would read the
 * env vars and permanently pick the backend at build time. Here each
 * limiter's backend is resolved on first actual use instead: an env-absent
 * fallback sticks for the process lifetime (env vars don't change
 * mid-process; the decision is re-evaluated on the next cold instance),
 * while a thrown Redis construction is retried after a cooldown rather than
 * cached permanently — a transient failure degrades one call, not the
 * instance.
 *
 * ADR: docs/adr/0025-rate-limiting-in-memory.md (superseded)
 * ADR: docs/adr/0056-upstash-redis-rate-limiter.md
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Cap on the fallback Map before expired windows are evicted. Without it,
 * every unique login adds an entry forever and Vercel functions have small
 * heaps.
 */
const MAX_FALLBACK_KEYS = 10_000;

/**
 * Cooldown before retrying a failed Redis client construction. A throw here
 * is not cached permanently — the next call after this window retries, so a
 * transient failure doesn't hammer Redis either.
 */
const REDIS_INIT_RETRY_COOLDOWN_MS = 30_000;

const KIND_CONFIG = {
  "repo-submission": { limit: 5, windowMs: 60 * 60 * 1000, window: "1 h" },
  "mission-action": { limit: 20, windowMs: 60 * 1000, window: "1 m" },
} as const;

type LimiterKind = keyof typeof KIND_CONFIG;
type InMemoryLimiter = ReturnType<typeof createRateLimiter>;
type Limiter = Ratelimit | InMemoryLimiter;

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
    if (hits.size >= MAX_FALLBACK_KEYS && !hits.has(key)) {
      evictExpiredWindows(hits, windowStart);
    }
    hits.set(key, recent);
    return { allowed: true };
  };
}

/**
 * Drops entries whose newest hit is outside the window (before windowStart).
 * Called only when inserting a new key would grow the Map past
 * MAX_FALLBACK_KEYS; updates to an existing key never grow it. Entries whose
 * newest hit is still inside the window survive. Deleting during iteration is
 * safe for JS Maps.
 */
function evictExpiredWindows(hits: Map<string, number[]>, windowStart: number): void {
  for (const [key, timestamps] of hits) {
    const newest = timestamps[timestamps.length - 1];
    if (newest === undefined || newest <= windowStart) {
      hits.delete(key);
    }
  }
}

interface LimiterEntry {
  /**
   * In-memory limiter, created on first use so its hit counts persist across
   * Redis outages instead of resetting per failed init attempt.
   */
  fallback: InMemoryLimiter;
  /** Resolved Redis limiter, or null until a successful init. */
  redis: Ratelimit | null;
  /**
   * Env vars absent — stable for the process lifetime, so the fallback
   * decision sticks (re-evaluated on the next cold instance).
   */
  redisUnavailable: boolean;
  /** Cooldown clock for retrying a thrown Redis init (see REDIS_INIT_RETRY_COOLDOWN_MS). */
  lastFailedInitAt: number;
}

const limiterEntries = new Map<LimiterKind, LimiterEntry>();
let redisClient: Redis | null = null;

function getRedisClient(url: string, token: string): Redis {
  if (redisClient !== null) {
    return redisClient;
  }

  redisClient = new Redis({ url, token });
  return redisClient;
}

function getLimiter(kind: LimiterKind): Limiter {
  const config = KIND_CONFIG[kind];
  let entry = limiterEntries.get(kind);
  if (entry === undefined) {
    entry = {
      fallback: createRateLimiter(config.limit, config.windowMs, kind),
      redis: null,
      redisUnavailable: false,
      lastFailedInitAt: 0,
    };
    limiterEntries.set(kind, entry);
  }

  if (entry.redis !== null) {
    return entry.redis;
  }
  if (entry.redisUnavailable) {
    return entry.fallback;
  }
  if (Date.now() - entry.lastFailedInitAt < REDIS_INIT_RETRY_COOLDOWN_MS) {
    return entry.fallback;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url === undefined || url === "" || token === undefined || token === "") {
    entry.redisUnavailable = true;
    console.warn(
      "[rate-limit] UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set — " +
        "falling back to in-memory rate limiter (not suitable for production)",
    );
    return entry.fallback;
  }

  try {
    const redis = getRedisClient(url, token);
    entry.redis = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(config.limit, config.window),
      prefix: `ratelimit:${kind}`,
      analytics: true,
    });

    console.warn(`[rate-limit] Upstash Redis rate limiter initialized (kind=${kind})`);
    return entry.redis;
  } catch (err) {
    entry.lastFailedInitAt = Date.now();
    console.error("[rate-limit] Failed to initialize Upstash Redis rate limiter:", err);
    return entry.fallback;
  }
}

async function checkWithLimiter(kind: LimiterKind, login: string): Promise<RateLimitResult> {
  const limiter = getLimiter(kind);
  if (limiter instanceof Ratelimit === false) {
    // In-memory fallback (synchronous; cannot throw)
    return Promise.resolve(limiter(login));
  }
  try {
    const result = await limiter.limit(login);
    if (result.success) {
      return { allowed: true };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((result.reset - Date.now()) / 1000),
    };
  } catch (err) {
    // Fail-open is the deliberate decision (TASK-02 / ADR 0056): rate
    // limiting is abuse protection, not a security boundary, so a Redis
    // outage must not take down mission claiming. Logged loudly so the
    // outage is visible. Unreachable on the in-memory path, which cannot
    // throw.
    console.error(`[rate-limit] Redis limit() failed for kind=${kind} — failing open:`, err);
    return { allowed: true };
  }
}

/**
 * Check rate limit for repo submission (5 per hour per login).
 * Uses Upstash Redis if configured, otherwise in-memory fallback.
 */
export async function checkRepoSubmissionLimit(login: string): Promise<RateLimitResult> {
  return checkWithLimiter("repo-submission", login);
}

/**
 * Check rate limit for mission actions (20 per minute per login).
 * Shared pool for claim/unclaim/bookmark/unbookmark.
 * Uses Upstash Redis if configured, otherwise in-memory fallback.
 */
export async function checkMissionActionLimit(login: string): Promise<RateLimitResult> {
  return checkWithLimiter("mission-action", login);
}
