/**
 * Vitest setup for the app workspace — runs before each test file's modules
 * are imported.
 *
 * Deletes the Upstash rate-limiter credentials from process.env so the test
 * suites are hermetic.
 *
 * Why this exists: `app/src/lib/rate-limit-redis.ts` resolves its backend
 * lazily from process.env, falling back to the in-memory limiter when the
 * credentials are absent. That is the documented contract for tests (and what
 * CI gets, since the CI `test` job sets no UPSTASH_* secrets). But vitest
 * inherits the ambient shell environment, so on a developer machine that has
 * `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` exported (a sourced
 * .env.local, direnv, `node --env-file`, …) the route suites and
 * `rate-limit.test.ts` silently write real keys to the *production*
 * rate-limit database instead — observed 2026-11-15: 20
 * `ratelimit:repo-submission:user-*` keys (1 h TTL) appeared in the live DB
 * after a local `vitest run`, consuming shared free-tier commands and leaving
 * cross-run state that can flake the per-login budget assertions.
 *
 * Tests that need the Redis path set these variables themselves
 * (`rate-limit-redis.test.ts` does, per test, and restores them afterwards),
 * so deleting them here costs nothing and makes every suite deterministic.
 */

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

export {};
