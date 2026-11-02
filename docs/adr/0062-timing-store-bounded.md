# ADR 0062: Bound the per-request timing store (production memory growth fix)

**Status:** Accepted (flipped 2026-11-02, same-day live verification)
**Date:** 2026-11-02
**Related:** ADR 0052 (Server-Timing header), ADR 0056 (rate limiter, whose fallback Map set the eviction pattern)

---

## Context

ADR 0052's follow-up ("S2") added a per-request timing store
(`app/src/lib/timing/store.ts`): the middleware mints an `x-request-id`,
`withTiming()` records per-segment durations into a module-level
`Map<requestId, TimingStore>`, and `logTimingsForRequest()` reads entries
back for the `[deptend:timing]` stdout line.

The 2026-11-02 production performance audit found the store grows without
bound:

- `withTiming()` records on **every** page render — it wraps all shared reads
  (`missions:board`, `repos:directory-summary`, `cache:*` segments) via
  `lib/queries/missions.ts` and `cached-read.ts`.
- In production, the **only** consumer (`logTimingsForRequest`, called from
  `/missions` alone) returns before reading anything (`log.ts`'s
  `!isDev && !forceEnabled` early return), so entries are written and never
  read.
- Nothing ever deleted a request's store. Every request to any page left one
  `Map` entry behind for the process lifetime. At production scale this is a
  slow leak (entries are tiny), but it is unbounded by design: a long-lived
  warm function accumulates one entry per request forever, and the store
  cannot be reasoned about as bounded.

This is the same failure class the rate limiter's in-memory fallback already
solved for its own `Map` (`MAX_FALLBACK_KEYS` + `evictExpiredWindows`,
`rate-limit-redis.ts`); the timing store predated that guard and never got
the same treatment.

## Decision

Two guards, both inside the existing modules — no new dependencies, no
schema, no middleware changes:

1. **Delete-after-final-read.** `logTimingsForRequest()` now deletes the
   request's store in both terminal paths:
   - the production early-return (the path that never reads — this is what
     bounds production), and
   - the deferred `"full"` flush pass's `setImmediate` callback (the last
     read on the logging path, so the synchronous `"page-done"` pass and the
     deferred read still see the data).
2. **Hard cap with oldest-inserted eviction.** `getOrCreateStore()` evicts
   the oldest-inserted store (`Map` keys iterate in insertion order) when a
   new store would push the map past `MAX_STORED_REQUESTS` (10,000) —
   mirroring `MAX_FALLBACK_KEYS`. This covers the straggler race: a Suspense
   fetch completing after the delete re-creates the store on write, and the
   cap is the flood guard if that ever happens at volume.

Worst-case behavior under either guard: timing observability degrades (an
entry is evicted or a late write re-creates an empty store), never app
behavior — the store is write-only infrastructure on every path except
`/missions`'s dev-only logger.

## Alternatives considered

- **Stop recording in production.** `withTiming()` could no-op entirely when
  `NODE_ENV=production`. Rejected: the store exists so a future metrics
  export (ADR 0052's flagged follow-up) can ship without re-instrumenting
  the read layer, and `DEPTEND_TIMING_LOG=1` already provides a production
  opt-in that depends on the data being collected.
- **TTL-based eviction** (timestamp each store, sweep on access). More code
  for no benefit over the cap: entries are write-once per request and the
  delete-after-read covers the common case; the cap alone would already
  bound memory.

## Consequences

- Production memory from timing is now bounded: ≤ 10,000 stores plus the
  in-flight stragglers, and in practice ~zero steady-state (every request's
  store is deleted when its request ends).
- The `/missions` dev logger is unchanged in output; only ownership of the
  store's lifetime moved (logger deletes after final read).
- Any future consumer of the store (metrics endpoint, log drain) must keep
  the delete-after-final-read invariant — it is documented at
  `MAX_STORED_REQUESTS` and in `logTimingsForRequest`.

## Update (2026-11-02, later the same day — backlog pass)

The ADR 0052 per-segment follow-up landed alongside this fix: all four read
pages (`/`, `/missions`, `/org/[org]`, `/repo/[owner]/[name]`) now call
`logRequestTimings()` (new dynamic-resolution wrapper in `log.ts`), so the
`[deptend:timing]` stdout line covers every read path under
`DEPTEND_TIMING_LOG=1` in production. The Context section above describes
the state found by the audit (only `/missions` called the logger); the
guards are unchanged — all four callers are dev-only by default, and the
production early-return delete plus the cap still bound the store.

`pg_stat_statements` was also installed on the production Neon branch the
same day (user-approved decision point; the slow-query harness item from
the audit backlog), so app-query latency is now observable DB-side too.

### Accepted — live verification (2026-11-02)

Shipped in `0980558` and deployed as production `dpl_71aWwSmd1i1KBcsc2W9eVWWfmLDb`
(READY). Post-deploy live check against `deptend.vercel.app`:

- All four pages HTTP 200 with unchanged payloads (byte sizes identical to
  the audit's pre-deploy probes), `Server-Timing: total;dur=0.2–2.6` (the
  middleware-phase header, unchanged behavior).
- 30-request burst across `/` and `/missions`: 30/30 × HTTP 200, zero
  failures — pages keep serving normally with the eviction + delete guards
  in place. The 8-test unit suite (`store.eviction.test.ts`) carries the
  behavioral proof of the bounds themselves; real production can't be
  introspected for Map size on Vercel Hobby, so serving behavior plus the
  unit contract is the honest evidence available.

## Verification

- New unit suite `app/src/lib/timing/store.eviction.test.ts` (6 tests): cap
  evicts oldest-inserted and only on overflow; updates never evict;
  `deleteStore` no-op safety; production early-return deletes; dev path
  keeps the store until the deferred full pass (fake timers); read path
  intact.
- Full §6 gate run in the same pass (typecheck / test / build / lint /
  format:check / tsconfig.eslint.json checks).
- **Live verification (required to flip to Accepted):** after the next
  production deploy, confirm steady-state growth is bounded — e.g. burst
  100 requests across `/` and `/missions`, then verify no
  `[deptend:timing]` regressions and no memory growth signal in Vercel
  function metrics. Because prod default never logs, the practical check is
  simply that pages keep serving normally after a burst; the unit suite
  carries the behavioral proof.
