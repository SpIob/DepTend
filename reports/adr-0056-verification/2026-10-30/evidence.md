# ADR 0056 live verification — 2026-10-30

Production live-verification evidence for ADR 0056 (Upstash Redis rate limiter).
All checks run against https://deptend.vercel.app with a real authenticated
GitHub session (SpIob), in the user's own browser, at ~2026-10-30T05:30–05:40Z.

## Environment verified before the live run

| Check                                                                                                 | Result                                                                                              |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Upstash REST credentials from `.env.local` (app's exact `@upstash/redis` + `@upstash/ratelimit` libs) | `PING` → `PONG` in 275 ms                                                                           |
| Sliding window at limit=5/min (probe prefix, cleaned up after)                                        | 5 allowed → 2 denied, keys deleted post-test                                                        |
| Vercel env vars (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`)                                | Present on production / preview / development (Vercel MCP `filter_project_envs`)                    |
| GitHub Actions secrets                                                                                | Both listed by `gh secret list`, created 2026-10-30                                                 |
| Forced production redeploy `dpl_BGxL6XoKLAG2WY7nGeJ3e5PT9Zjx` (commit `e0a667eb`)                     | READY; `GET /` → 200                                                                                |
| Redis state before any signed-in request                                                              | `dbsize 0` — limiter not yet initialized (only initializes on first authenticated mutating request) |

## Check 1 — rate-limit threshold and 429 headers (live, authenticated)

21 same-origin `POST /api/missions/<random-uuid>/claim` requests from the
authenticated browser session. A random UUID cannot mutate anything; the
route gate (`app/src/lib/route-gate.ts`) runs the rate limiter _before_ UUID
validation, so the burst exercises the limiter directly.

```
#01..#20 → 404 {"error":"Mission not found."}        (limiter allowed; DB lookup missed)
#21      → 429 Retry-After: 33
            {"error":"Too many mission actions. Try again shortly."}
```

Exactly the configured 20/min threshold: 20 requests pass the limiter, the
21st is denied with a real, positive `Retry-After` header (33 s < 60 s window,
consistent with a sliding-window reset). Unauthenticated burst requests stop
at 401 before reaching the limiter (gate order origin → session → rate-limit),
so the evidence necessarily comes from a signed-in session.

## Check 2 — distributed state lives in Upstash, not the in-memory fallback

Redis scan immediately after the burst (same credentials as the pre-flight):

```
dbsize: 2
ratelimit:mission-action:SpIob:29888978   (ttl 51s — counting down the 60s window)
ratelimit:mission-action:events:1793336400000  (analytics time bucket, ttl -1)
```

The `ratelimit:mission-action:<login>:<window>` key — the exact prefix the
app's `checkMissionActionLimit()` writes (`app/src/lib/rate-limit-redis.ts`,
prefix `ratelimit:mission-action`) — exists in the remote Upstash database
with a countdown TTL. The in-memory fallback never touches Redis, so
production served the burst from the Upstash-backed limiter.

## Scope note (what this run does and does not demonstrate)

- Demonstrated: real Upstash-backed sliding window in production, correct
  denial threshold (20/min), `Retry-After` on the 429, per-login distributed
  state persisted in Redis across the app's serverless instances.
- Not literally reproduced: the ADR's original "100 concurrent requests from
  different IPs" load test — a single-machine single-login run cannot
  simulate distinct IPs (the limit is per-login, and one login cannot fan out
  to distinct identities from one machine). The ADR's Verification section
  has been rewritten around what is actually demonstrated; the uncorroborated
  claims are retracted rather than asserted.
- The mission-action family (claim/unclaim/dismiss/undismiss, bookmarks,
  notifications) all share `checkMissionActionLimit` via `gateRequest()`;
  repo submission (5/hr) uses the same limiter code path with a different
  config, so the demonstrated 20/min evidence covers the mechanism.
