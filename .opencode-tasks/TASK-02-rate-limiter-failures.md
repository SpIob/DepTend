# TASK-02 — Fix the Redis rate limiter's failure modes

**Agent:** opencode · **Priority:** high
**Area:** `app/src/lib/rate-limit-redis.ts` (+ its test file if one exists; create
`app/src/lib/rate-limit-redis.test.ts` if not, matching `rate-limit.ts`'s test style)

## Evidence (read from source, 2026-09-25)

`app/src/lib/rate-limit-redis.ts` has three real failure modes, all in one module:

1. **Module-load initialization (§12 pitfall class).** `initializeLimiters()` runs at
   import time (line 109). The exact same pattern is documented in this repo as a
   production-outage class: "Route modules can get evaluated at Vercel build time even
   for pages marked force-dynamic; use a lazy DB singleton, not a top-level const" (§12,
   Build & tooling). Here, module-load init means:
   - During a Vercel **build**, `UPSTASH_REDIS_REST_URL`/`TOKEN` are read then — if
     they're absent at build time, `getRedisClient()` returns null and the module
     **st**icks to the in-memory limiter for the whole cold instance (`redisClient` is
     null, `initializeLimiters` re-created the in-memory limiters, and nothing ever
     retries the Redis path).
   - Worse: `getRedisClient()` returns null BOTH when env vars are unset (line 65) and
     when `new Redis()` throws (line 76), and `initializeLimiters` can't tell the
     difference. A transient failure at first import permanently degrades to in-memory.
2. **No error handling on the Redis `limit()` call.** `checkRepoSubmissionLimit` (line 115) and `checkMissionActionLimit` (line 135) `await limiter.limit(login)` with no
   try/catch. Upstash REST outages, 429s from Upstash itself, or network errors would
   throw → the mutating route's handler gets a 500 instead of a graceful
   fail-open-or-closed decision. The in-memory fallback path never throws — the two
   paths have different failure semantics and the Redis one is unhandled.
3. **Unbounded in-memory fallback growth.** `createRateLimiter`'s `hits` Map (line 23)
   keys on login and never evicts; every unique login adds an entry forever. On the
   fallback path (which production is currently ON — Vercel env has no
   `UPSTASH_REDIS_REST_*`, verified via MCP 2026-09-25), a page with attacker-style
   unique logins can't reach this Map (login is JWT-validated per AGENTS.md §12 Auth),
   but every real user grows it permanently. Vercel functions have small heaps.

## Known constraints (binding)

- Production currently runs the **in-memory fallback** (`UPSTASH_REDIS_REST_*` absent in
  Vercel env — a flagged decision point for Mico, ADR 0056; do NOT create an Upstash
  account or secrets as part of this task).
- The two exported functions' signatures are load-bearing: `checkRepoSubmissionLimit(login)
→ Promise<RateLimitResult>` and `checkMissionActionLimit(login) → Promise<RateLimitResult>`,
  consumed by all 10 mutating API routes and `route-gate.ts`. Do not change the
  signatures or the `RateLimitResult` shape.
- ADR 0025 documents why in-memory-over-Redis was chosen originally; ADR 0056 superseded
  it. Both files' comments reference each other — keep the ADR references intact.
- Fail-open vs fail-closed on Redis errors is a **decision**: this task picks
  **fail-open** (allow the request) because rate limiting is abuse protection, not a
  security boundary, and a Redis outage must not take down mission claiming — but
  log it loudly (`console.error`) so the outage is visible. Document the choice in a
  code comment; do not silently pick the other side.
- Per AGENTS.md §0.6, load `.opencode/skills/actually-code` before writing code.

## What to do

1. **Make initialization lazy.** Replace module-load `initializeLimiters()` with a
   `getLimiter(kind)` lazy singleton per kind (mirroring `app/src/lib/db.ts::getDb()`'s
   shape and comment style): first call reads env vars, tries Redis, and falls back to
   in-memory; the decision is re-evaluated on the next cold instance, not stuck for the
   module's lifetime. If Redis init throws, log and fall back — do NOT cache the failed
   state permanently (retry on next call, with a short cooldown to avoid hammering).
2. **Wrap `limit()` in try/catch** in both check functions: on Redis error, log loudly
   and fail open (return `{ allowed: true }`) per the decision above. Keep the
   in-memory path's behavior unchanged (it can't throw).
3. **Bound the fallback Map.** Evict expired windows from `createRateLimiter`'s `hits`
   Map — simplest correct shape: when the Map exceeds a cap (e.g. 10_000 keys), drop
   entries whose newest timestamp is outside the window before inserting. Keep it
   dependency-free (no LRU package).
4. **Add unit tests** covering: (a) the Redis-error fail-open path (mock `Ratelimit`'s
   `limit` to throw — mock at the module boundary, real contract: `Ratelimit.limit`
   returns `{success, reset}`, so the throw case is the only way to exercise the
   catch), (b) the lazy init re-evaluating on a second cold instance (reset module
   state between tests via `vi.resetModules()`), (c) the Map eviction cap, (d) the
   in-memory fallback still blocking over-limit keys (existing behavior, keep it green).
   Follow `app/src/lib/rate-limit.ts`'s existing test style if present; check
   `app/vitest.config.ts` provides the `@/` alias for the new test file's imports.
5. **Verify against the real gate**, full §6.

## Verification gate (run in this order before claiming done)

```bash
pnpm run typecheck && pnpm -r test && pnpm run build && pnpm run lint && pnpm run format:check
```

Plus: all 10 route-level suites stay green (they consume these functions — a signature
or shape change breaks them loudly; keep them unchanged).
