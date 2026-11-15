# Upstash DB audit — evidence (2026-11-15)

Trigger: Upstash notified that the `deptend-rate-limit` database had received no
traffic "in a while" and would be archived without activity.

All checks ran against the live database `robust-elk-244122.upstash.io` using the
app's own `@upstash/redis` + `@upstash/ratelimit` versions (`1.40.0` / `2.2.0`)
and the credentials in `.env.local` (which `app/.env.local` symlinks to, so the
dev and production deploys point at the same DB). Credential values are never
printed here or in any script output.

## 1. State of the database at the start of the audit

```
PING   → PONG (468 ms cold)
DBSIZE → 1
SCAN 0 → ["0", ["ratelimit:mission-action:events:1793336400000"]]
```

The only key in the database was an **analytics bucket left by the ADR 0056
verification burst on 2026-10-30** (`1793336400000` = 2026-10-30T05:00:00Z).
Nothing had touched the DB in the 16 days since:

```
TYPE   ratelimit:mission-action:events:1793336400000 → zset
TTL    → -1                       (never expires)
ZCARD  → 2
ZRANGE WITHSCORES →
  {"identifier":"SpIob","success":false}  score 1
  {"identifier":"SpIob","success":true}   score 20
```

So the notice was **not** a symptom of broken credentials: the limiter works, it
is just only reachable on authenticated mutating requests (gate order origin →
session → rate-limit), which are rare on a project this size. Per Upstash's FAQ
("Free tier databases are archived after a minimum of 30 days of inactivity.
Users get several warning emails prior to this operation"), this is the
pre-warning at day 16.

## 2. `analytics: true` vs `analytics: false` (measured, not assumed)

Probe with the app's real libraries, 4 `limit()` calls per variant, probe keys
deleted afterwards:

| Variant            | Keys written | Events key TTL | First-call latency |
| ------------------ | ------------ | -------------- | ------------------ |
| `analytics: true`  | 2            | **-1 (never)** | 98 ms              |
| `analytics: false` | 1            | n/a            | 36 ms              |

```
--- analytics=true ---
ratelimit:zzprobe-with-analytics:events:1794700800000  ttl=-1
ratelimit:zzprobe-with-analytics:probe-user:29911717   ttl=119
--- analytics=false ---
ratelimit:zzprobe-no-analytics:probe-user:29911717     ttl=119
```

`@upstash/ratelimit` builds its analytics store with `retention: "90d"`
(`dist/index.js`, `Analytics` class), but that retention is only consulted by the
read path (`getUsage`/`series`) — no expiry is applied at write time, so each
hour-bucket key lives forever, one per limiter kind per hour of traffic. Nothing
in this repo reads that data:

```
grep -rn "getUsage|\.series(" app/src packages/core/src cli/src scripts/*.mjs scripts/*.js
→ no matches (the only "analytics" hit in app code is @vercel/analytics in layout.tsx)
```

Actions taken: `DEL ratelimit:mission-action:events:1793336400000` (`DBSIZE 1 → 0`),
and `analytics: false` in `app/src/lib/rate-limit-redis.ts`.

## 3. Health/keepalive script — live runs

Happy path (real Upstash, 2026-11-15):

```
$ node --env-file=.env.local scripts/upstash-health.mjs
OK: Upstash alive (ping 191 ms, round-trip 306 ms, key deptend:keepalive ttl 604800 s)
exit=0
```

The run left verifiable activity in the database — this is the keepalive:

```
DBSIZE                → 1
SCAN 0                → ["0", ["deptend:keepalive"]]
TTL deptend:keepalive → 604647   (7-day TTL, counting down)
GET deptend:keepalive → "2026-11-15T07:09:43.642Z"
```

Failure paths, both run against the real endpoint:

```
$ env -u UPSTASH_REDIS_REST_URL -u UPSTASH_REDIS_REST_TOKEN node scripts/upstash-health.mjs
[upstash-health] UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set
exit=1

$ UPSTASH_REDIS_REST_TOKEN="invalid-token-for-test" node scripts/upstash-health.mjs
[upstash-health] invalid credentials (HTTP 401)
exit=1
```

The 401 (rather than a 404 or an archived-database error) also confirms the
database is currently **alive and answering**.

### Bug found by running it, not by the tests

The first cut ended in `switch (result.reason)` with a `case "ok"`. A healthy
result carries `ok: true` and **no** `reason` property, so the success path
matched no case — the script printed nothing and exited 0:

```
$ node --env-file=.env.local scripts/upstash-health.mjs   # before the fix
(no output)
exit=0
```

No exception, no failure, no log line: a health check that looks green while
recording nothing. Fixed by moving message/exit-code mapping into a pure, tested
`formatResult(result)`, which also now names the likely cause on an HTTP error
("the database may be archived …"). This is the AGENTS.md §6 meta-lesson again —
every unit test of `checkUpstashHealth` was green; only the live run exposed it.

## 3b. Test suites were writing to the production database (found + fixed)

Running the app suite locally with the credentials present in the shell (this
session had sourced `.env.local`) left real keys in the live DB:

```
DBSIZE before                              → 1
(app suite run, exit 0, 237 tests passing) → 21
SCAN 0 → ["0", ["deptend:keepalive",
                "ratelimit:repo-submission:user-0d62bee9-…:498535",
                "ratelimit:repo-submission:repo-test-7729bd3a-…:495888",
                … 18 more ]]
```

Those `user-<uuid>` / `repo-test-*` logins are the fixtures the route suites and
`rate-limit.test.ts` use, and the `1 h` windows are `checkRepoSubmissionLimit`'s.
Cause: the limiter resolves its backend lazily from `process.env`, and vitest
inherits the ambient shell environment — CI never sets these secrets, so the
documented contract ("tests use the in-memory fallback") only holds there.

Fix: `app/vitest.setup.ts` deletes both variables before any test module loads
(`setupFiles` in `app/vitest.config.ts`). Verified by observation:

```
20 polluted keys DELeted      → DBSIZE 1 (only deptend:keepalive)
app suite, creds still exported in the shell → 23/23 files, 237/237 tests, exit 0
run log line                  → [rate-limit] UPSTASH_REDIS_REST_URL or
                                UPSTASH_REDIS_REST_TOKEN not set — falling back
                                to in-memory rate limiter
DBSIZE after the run          → 1, keys: ["deptend:keepalive"]
```

## 4. Test + gate results

| Check                                           | Result                                                                                                                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/upstash-health.test.js`                | **16/16 pass** (8 health cases + timeout, not-found, secret-leak guard, 3 `formatResult`, 4 credential cases)                                                                                                                                 |
| `app/src/lib/rate-limit-{redis,}.test.ts`       | **27/27 pass** (incl. 2 new assertions that the constructor receives `analytics: false`)                                                                                                                                                      |
| `app` full suite (`vitest run`)                 | **237/237 pass** across 23 files (including all ten route suites' 429 cases, the real limiter path)                                                                                                                                           |
| `packages/core` full suite                      | **874/874 pass** across 45 files                                                                                                                                                                                                              |
| `pnpm typecheck`                                | clean (core, cli, app, scripts)                                                                                                                                                                                                               |
| `pnpm --filter app build` (Next.js, production) | clean                                                                                                                                                                                                                                         |
| `pnpm lint` (`--max-warnings 0`)                | clean                                                                                                                                                                                                                                         |
| `pnpm format:check`                             | clean for every touched file (one pre-existing exception, §5.2)                                                                                                                                                                               |
| `.github/workflows/health-check.yml`            | YAML parses; steps `[Checkout, Check public endpoints, Check Upstash rate-limit database, Email on failure]`; the Upstash step carries both `UPSTASH_REDIS_REST_*` secrets and runs before the `if: failure()` email step; cron `0 */6 * * *` |

## 5. Findings NOT fixed here (reported rather than silently patched)

1. **`scripts/integration.test.js` fails locally (4/4).** It is
   `describe.skipIf(!process.env.DATABASE_URL)`, so CI's `test` job (which sets no
   `DATABASE_URL`) skips it — that is why main CI is green. Run locally against
   dev Neon it fails with Postgres `21000: more than one row returned by a
subquery used as an expression`: its cleanup does
   `delete … where dependency_id = (select id from dependencies where repo_id = $1)`,
   a single-row subquery, while dev's `deptend-go-test-fixture` now holds **2**
   `go` dependency rows (verified with a read-only query against dev
   `br-cool-grass-aocbg2b7`). Pre-existing and unrelated to this change; the fix
   is `inArray(...)` instead of `eq(...)`. Left alone as a scope decision.
2. **`GROWTH_PLAN.md` fails `prettier --check`.** An untracked local document
   modified today at 08:25, before this session; it is the only file
   `pnpm format:check` still flags after this change. Not touched — it is the
   user's own file.
3. **The rate limiter only covers authenticated mutating requests.** Gate order is
   origin → session → rate-limit, so `/api/auth/*` and every unauthenticated
   request are unlimited, and limits are keyed per GitHub login with no IP
   dimension. No production impact observed, but an unauthenticated client can
   hammer the auth endpoints without ever touching the limiter or the database.
   Changing this is a behavior change (new keying dimension, new ADR, route-suite
   updates) — raised as a decision point, not implemented.
4. **Production credentials could not be re-read from here.** The Vercel MCP
   connection now returns HTTP 403 for team `team_3LPFkSavNvL9Dr7Wx1JirgO5`
   ("antigen") and needs the user to approve a fresh team grant, so
   `filter_project_envs` could not be re-checked this session. The evidence that
   production uses this database remains the 2026-10-30 run (the `SpIob`
   identifiers in §1 were written by a production request) plus the fact that env
   vars set on 2026-10-30 persist. The new health-check step is the ongoing,
   automated confirmation of exactly that.

## 6. Summary table for ADR 0064

| Claim                                                            | Evidence                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| DB idle since 2026-10-30 (16 days)                               | §1 — DBSIZE=1, the only key being the 2026-10-30 events ZSET             |
| `analytics: true` writes a TTL=-1 events ZSET with per-login IDs | §1 + §2 (probe A)                                                        |
| `analytics: false` writes only the transient window key          | §2 (probe B)                                                             |
| No repo consumer of the analytics data                           | §2 grep                                                                  |
| Health script keeps the DB active and detects archival           | §3 live runs (happy + two failure paths) + §4 unit matrix                |
| Silent fail-open on an archived DB is a real security regression | ADR 0056's deliberate fail-open; the health step now surfaces the outage |
| Standard gate green                                              | §4                                                                       |
