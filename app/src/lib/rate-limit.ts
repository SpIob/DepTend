/**
 * Rate limiting — Redis-backed (Upstash) with in-memory fallback.
 *
 * This module re-exports the rate limiter functions from rate-limit-redis.ts.
 * The actual implementation uses Upstash Redis for distributed rate limiting
 * that persists across serverless instances and cold starts.
 *
 * Falls back to in-memory limiter (defined in this file) when UPSTASH_REDIS_REST_URL
 * and UPSTASH_REDIS_REST_TOKEN are not configured (e.g., local development).
 *
 * ADR: docs/adr/0025-rate-limiting-in-memory.md (superseded by Upstash adoption)
 */

import {
  checkRepoSubmissionLimit,
  checkMissionActionLimit,
  createRateLimiter,
} from "./rate-limit-redis";

export type { RateLimitResult } from "./rate-limit-redis";

// Re-export the rate limiter functions
export { checkRepoSubmissionLimit, checkMissionActionLimit, createRateLimiter };
