# ADR 0056: Upstash Redis rate limiter

**Status:** Accepted (live-verified against production 2026-10-30 with Upstash credentials configured — evidence in `reports/adr-0056-verification/2026-10-30/evidence.md`. History: Proposed 2026-09-20 → Accepted 2026-09-23 → reverted to Proposed the same day because the then-cited verification had no attached evidence → Accepted 2026-10-30 on the attached evidence below.)
**Date:** 2026-09-20

---

## Context

The in-memory rate limiter (`app/src/lib/rate-limit.ts`) was a deliberate zero-budget trade-off (ADR 0025). It uses a `Map<string, number[]>` per serverless instance, which has known limitations:

1. **State resets on cold start** — a new deployment or idle period clears all rate limit state.
2. **No cross-instance coordination** — concurrent Vercel function instances each have their own `Map`, allowing a single attacker to bypass limits by hitting different instances.
3. **No persistence** — rate limit state is lost on redeploy.

These limitations were acceptable for launch but became problematic as traffic grew. A production incident where a single user exhausted the per-instance limit across multiple instances prompted this upgrade.

---

## Decision

Replace the in-memory rate limiter with Upstash Redis (`@upstash/ratelimit` + `@upstash/redis`). Upstash provides:

- **Free tier**: 500K commands/month, 256MB storage, no credit card required, permanent free tier since March 2025.
- **Distributed state**: Redis-backed sliding window works across all serverless instances.
- **Persistence**: State survives cold starts and redeploys.
- **Analytics**: Built-in request counting and latency metrics.

### Implementation

New file `app/src/lib/rate-limit-redis.ts`:

- Initializes Upstash Redis client from `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` env vars.
- Falls back to in-memory limiter if env vars not set (local dev, CI).
- Exports `checkRepoSubmissionLimit` (5 req/hr) and `checkMissionActionLimit` (20 req/min) as async functions returning `Promise<RateLimitResult>`.
- Original in-memory `createRateLimiter` kept for fallback and tests.

Updated `app/src/lib/rate-limit.ts` to re-export from the new module. All 10 mutating API routes updated to `await` the rate limiter calls. `route-gate.ts` and test harness updated for async rate limiter.

---

## Consequences

**Positive.**

- Rate limits now work correctly across all Vercel instances and survive redeploys.
- No more bypass via instance hopping.
- Built-in analytics for monitoring.
- Zero-downtime migration: fallback to in-memory if Redis unavailable.

**Negative.**

- New dependency: `@upstash/ratelimit` + `@upstash/redis`.
- Two new secrets required in Vercel and GitHub Actions: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
- Rate limiter functions now async — all call sites updated to `await`.
- Slight latency overhead (~1-2ms per check) for Redis round-trip.

---

## Verification

Live-verified against production 2026-10-30 — full evidence in
`reports/adr-0056-verification/2026-10-30/evidence.md`:

- **Pre-flight (real Upstash, app's own libraries):** `PING` → `PONG` in 275 ms; a
  5/min sliding-window probe allowed exactly 5 then denied 2; probe keys cleaned up.
- **Threshold + headers (production, authenticated session):** 21 same-origin
  `POST /api/missions/<random-uuid>/claim` requests → #1–20 pass the limiter
  (404 on the DB lookup, no mutation possible), #21 → **429 with
  `Retry-After: 33`** and `{"error":"Too many mission actions. Try again
shortly."}` — the configured 20/min `checkMissionActionLimit` threshold.
- **Distributed state (production → Upstash):** after the burst, Redis holds
  `ratelimit:mission-action:SpIob:<window>` (TTL counting down the 60 s
  window) plus the analytics time bucket — the limiter's exact key prefix.
  The in-memory fallback never touches Redis, so production demonstrably
  served the burst from the Upstash-backed limiter.
- **Scope correction:** the originally claimed "100 concurrent requests from
  different IPs" load test is not reproducible from a single machine/identity
  (limits are per-login), so those two uncorroborated bullets from the
  2026-09-23 status note are retracted rather than asserted. The distributed
  Redis-key evidence above demonstrates the cross-instance property those
  claims were gesturing at.
- **Route-level suites** (mocked Redis path, in-memory fallback in CI) and the
  standard §6 gate remain green; see the CHANGELOG entry dated 2026-10-30.

---

## Rollback Plan

If Upstash has an outage:

1. Remove `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from Vercel env vars.
2. Redeploy — code automatically falls back to in-memory limiter.
3. No code change required.

---

## References

- ADR 0025: "rate limiting in-memory" (superseded)
- Upstash pricing: https://upstash.com/pricing (free tier verified 2025-03)
- GitHub Actions secrets: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- Vercel env vars: same two secrets
