# ADR 0064: Upstash rate-limit DB liveness + analytics hygiene

**Status:** Accepted (live-verified against real Upstash 2026-11-15 — evidence in `reports/upstash-db-audit/2026-11-15/`)

**Date:** 2026-11-15

---

## Context

On 2026-11-15 Upstash notified that the `deptend-rate-limit` database "has not received traffic in a while and will be archived if no activity is done". Investigation revealed:

- The DB's only traffic since creation was the ADR 0056 verification burst on 2026-10-30 (16 days prior).
- DBSIZE = 1, holding only `ratelimit:mission-action:events:1793336400000` — an analytics key created by `@upstash/ratelimit`'s `analytics: true` option.
- The analytics key is a **sorted set (ZSET) with TTL = -1 (never expires)**, containing per-login identifiers (`{"identifier":"SpIob",...}`) from the verification run. With `retention: "90d"` configured but no expiry applied at write time, this key grows one per hour-bucket forever — an unbounded storage leak on a 256 MB free tier.
- The rate limiter is **only reachable on authenticated mutating requests** (gate order: origin → session → rate-limit). Real traffic to these endpoints is near-zero on a small project. An archived DB causes all `limit()` calls to throw, and the deliberate fail-open path (ADR 0056) **silently disables all rate limits** — a security regression with no observable signal.
- No consumer in the repo reads the analytics data (`getUsage`, `series` never called). The Upstash console's rate-limit analytics tab is the only viewer; it has never been consulted.
- The Upstash free tier's archival policy: minimum 30 days of inactivity, with warning emails. The notice arrived at day 16 — a pre-warning.

---

## Decision

### 1. Liveness keepalive + health check (prevents archival + detects dead DB)

Add a step to `.github/workflows/health-check.yml` (runs every 6 hours) that executes `scripts/upstash-health.mjs`:

- **PING** — proves reachability.
- **SET `deptend:keepalive` with 7-day TTL** — proves write access works; the key overwrite on each run keeps DBSIZE stable at ~2. A read-only token would fail here (catching mis-scoped credentials).
- **GET the key** — proves read access + data integrity.
- Exits 0 on success, 1 on any failure (missing creds, 401, 404/archived, network error, round-trip mismatch). Failure triggers the existing email alert step (`dawidd6/action-send-mail`).
- 6-hour cadence → 4 runs/day → ~12 commands/day → ~360 commands/month (well within the 500K free tier). The activity keeps the DB from hitting the 30-day idle threshold.

The script is also runnable locally: `node --env-file=.env.local scripts/upstash-health.mjs`.

### 2. Disable analytics in the rate limiter (hygiene + command savings)

Change `analytics: true` → `analytics: false` in `app/src/lib/rate-limit-redis.ts`.

**Justification (empirical):**

| Metric                       | analytics: true          | analytics: false |
| ---------------------------- | ------------------------ | ---------------- |
| Keys written per `limit()`   | 2 (window + events ZSET) | 1 (window only)  |
| Events key TTL               | -1 (never)               | N/A              |
| Commands per check (approx)  | 2-3                      | 1-2              |
| Per-login identifiers stored | Forever                  | Never            |
| Consumer in this repo        | None                     | None             |

The analytics option was listed as a "Positive" in ADR 0056 ("Built-in analytics for monitoring"). The evidence shows no monitoring occurs; the only effect is the leaky events key. This is a correction, not a new feature.

The orphaned events key from 2026-10-30 was deleted live (DBSIZE: 1 → 0).

### 3. Make the app test suites hermetic (found during this audit)

`app/vitest.setup.ts` (wired via `app/vitest.config.ts`'s `setupFiles`) deletes
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` from `process.env` before any
test module loads.

The limiter resolves its backend lazily from `process.env` and falls back to the
in-memory limiter when the credentials are absent — that is the documented test
contract, and what CI gets (its `test` job sets no `UPSTASH_*` secrets). But
vitest inherits the ambient shell environment, so a developer machine with the
credentials exported (a sourced `.env.local`, direnv, `node --env-file`) makes
the route suites and `rate-limit.test.ts` write **real keys to the production
rate-limit database**. Observed here: 20 `ratelimit:repo-submission:user-*` keys
(1 h TTL) appeared in the live DB after one local `vitest run` — shared free-tier
commands consumed, and leftover per-login state that can flake the budget
assertions on a re-run. Those keys were deleted.

`rate-limit-redis.test.ts` sets the variables itself, per test, and restores them
afterwards, so it still exercises the Redis path; nothing else needs them.

---

## Consequences

**Positive:**

- DB can never be archived for inactivity (activity every 6 hours).
- Silent fail-open is now detectable: an unreachable/archived DB fails the health check → email alert → fix before abuse.
- Rate limiter storage bounded to transient window keys (max 2 kinds × active logins × 60s TTL).
- ~50% fewer Redis commands per rate-limit check.
- No per-login PII retained in the DB (analytics key held identifiers forever).

**Negative:**

- Upstash console's rate-limit analytics tab will be empty (it reads the events ZSET). No internal consumer exists, so no loss of operational visibility.
- One-line config change; rollback is `analytics: true` (but the leak returns).

---

## Verification

All live-verified against real Upstash (`robust-elk-244122.upstash.io`) on 2026-11-15 — full evidence in `reports/upstash-db-audit/2026-11-15/evidence.md`:

1. **Pre-flight PING**: 468 ms cold, `PONG`; `DBSIZE` = 1, that one key being the 2026-10-30 analytics ZSET (`TTL -1`, containing `{"identifier":"SpIob",…}`) — i.e. 16 days of true idleness.
2. **Probe with `analytics: true`** (app's real libraries): 2 keys written — window key (TTL 119 s) + `events:` ZSET (**TTL -1**). Cleaned up after.
3. **Probe with `analytics: false`**: 1 key written — the window key only (TTL 119 s). Cleaned up after.
4. **Orphaned events key deleted**: `DEL ratelimit:mission-action:events:1793336400000` → `DBSIZE` 1 → 0.
5. **Health script, happy path (real DB)**: `node --env-file=.env.local scripts/upstash-health.mjs` → exit 0, `OK: Upstash alive (ping 191 ms, round-trip 306 ms, key deptend:keepalive ttl 604800 s)`; the run's activity verified in Redis afterwards (`SCAN` → `deptend:keepalive`, TTL 604647, value = run timestamp).
6. **Health script, failure paths (real DB)**: missing env vars → exit 1 with the credential message; a deliberately invalid token → exit 1 with `invalid credentials (HTTP 401)` — which also proves the DB is alive and not archived (an archived DB does not answer 401).
7. **Defect found and fixed during live verification**: the first cut ended in `switch (result.reason)`, but a healthy result carries `ok: true` and no `reason`, so the success path matched no case, printed nothing, and exited 0 silently. Message/exit-code mapping moved into a pure, tested `formatResult(result)`. Unit tests of `checkUpstashHealth` alone were green — only the live run exposed it.
8. **Gate green**: `pnpm typecheck`, `packages/core` 874 tests, `app` 237 tests (incl. all ten route suites' 429 paths), `scripts` health suite 16/16, `next build` (production), `pnpm lint` (`--max-warnings 0`), `pnpm format:check` on every touched file.
9. **Unit tests added**: `scripts/upstash-health.test.js` (16 cases: the full `HealthResult` union, timeout vs unreachable, `formatResult` exit codes — including a regression guard for the silent-success bug — plus a secret-leak guard that the token never appears in any output); `rate-limit-redis.test.ts` two new cases asserting the constructor receives `analytics: false` with the correct prefix for both limiter kinds.
10. **Test hermeticity (decision 3) verified by observation, not by assertion**: with the Upstash credentials deliberately exported into the shell, before the change a local `vitest run` left 20 `ratelimit:repo-submission:user-*` keys in the live DB (DBSIZE 1 → 21); after adding `app/vitest.setup.ts`, the same run (23/23 files, 237/237 tests, exit 0) left `DBSIZE` at 1, the sole key being `deptend:keepalive`, and the run log shows `[rate-limit] UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set — falling back to in-memory rate limiter`. The 20 polluted keys were deleted.

### Out-of-scope findings recorded during this audit (not fixed)

- `scripts/integration.test.js` fails locally (4/4) against dev Neon — its cleanup uses a single-row subquery (`= (select id …)`) while dev's `deptend-go-test-fixture` now holds 2 `go` dependency rows. It is `describe.skipIf(!DATABASE_URL)`, which is why main CI stays green; pre-existing, and the fix is `inArray(...)`.
- The limiter covers only authenticated mutating requests (no IP-keyed limit for `/api/auth/*` and other unauthenticated traffic) — a deliberate gate order, changing it needs its own ADR.

---

## Rollback Plan

If the keepalive causes issues (e.g., unexpected command cost):

1. Remove the step from `.github/workflows/health-check.yml`.
2. Revert `analytics: false` → `analytics: true` in `app/src/lib/rate-limit-redis.ts`.
3. Redeploy. The DB will return to idle state; archival risk resumes after 30 days.

---

## References

- ADR 0056: Upstash Redis rate limiter (superseded on analytics point)
- Upstash Redis FAQ: "Free tier databases are archived after a minimum of 30 days of inactivity"
- Upstash pricing: https://upstash.com/pricing (free tier: 500K commands/month, 256 MB)
- Live evidence: `reports/upstash-db-audit/2026-11-15/`
