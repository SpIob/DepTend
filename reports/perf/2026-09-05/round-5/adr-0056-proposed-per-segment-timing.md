# 0056 — per-segment timing helper for `/app`'s read layer (Proposed)

**Status:** Proposed. Round 5 of `reports/perf/2026-09-05/` is the verification
artifact. Acceptance requires (a) wiring into `/` and `/repo/[owner]/[name]`,
and (b) a Vercel preview deploy to confirm the data flows on real
infrastructure (not done yet — AGENTS.md §10).

## Context

ADR 0052's flagged follow-up was per-segment `Server-Timing` emission
from the read layer. Round 1 of `reports/perf/2026-09-05/` measured
73-81% of LCP as `elementRenderDelay` and identified the cache hit/miss
gap, the 5-table join duration, and the render time as the three
phases that needed separate timing. Round 2 confirmed the cache is
invisible in user-visible TTFB (so the segment split is most useful
for backend observability, not for client-side Web Vitals).

AGENTS.md §12 (Learned Pitfalls) calls out the App Router constraint
that blocks the obvious implementation: `next/headers`'s `headers()`
is sealed read-only
(`app/node_modules/next/dist/server/web/spec-extension/adapters/headers.js:96-109`).
The middleware is the only place that can set response headers, and it
runs BEFORE the page render, so it cannot observe page-render state
on the way out. This is a fundamental Next.js design constraint.

## Decision

Build a per-request timing store keyed by a request id, and capture
per-segment timings in the store. The middleware sets a fresh request
id on the way in (`x-request-id`); the page render reads it via
`next/headers()` and wraps itself in `withRequestStore()` so the
data fetches in `<Suspense>` boundaries can pick up the same id from
a module-level snapshot. The data is emitted via a `setImmediate`-
flushed stdout log (one JSON line per request, two passes: `page-done`
and `full`) that ships to a metrics endpoint when the project has one.

## Implementation

Five files (in `app/`):

- `src/lib/timing/store.ts` — `Map<requestId, TimingStore>`, `withTiming(label, fn)`,
  `withTimingFor(requestId, label, fn)`, `withTimingSync(label, fn)`, `recordTiming`,
  `readEntries`, `formatServerTimingEntries`, `_resetForTests`.
- `src/lib/timing/log.ts` — `logTimingsForRequest(path, totalMs, reqId)` with
  two-pass `setImmediate` flush.
- `src/lib/queries/cached-read.ts` — wrap the `unstable_cache` call in
  `withTiming("cache:<tag>", ...)`.
- `src/lib/queries/missions.ts` — wrap the cached reads and the
  uncached reads in `withTiming(...)`.
- `src/middleware.ts` — `crypto.randomUUID()` on the way in, set on
  request and response as `x-request-id`. Existing `Server-Timing: total;dur=...`
  segment preserved.

Five segment labels today: `missions:board`, `missions:repo-board`,
`cache:repos`, `cache:missions`, `repos:directory-summary`,
`repos:by-owner-name`, `repos:bookmarks`, `repos:ecosystems`, plus
`page:render` from the page's outer render.

## Verification

Round 5 of `reports/perf/2026-09-05/`. Live data from the verification run:

```text
[deptend:timing] {"reqId":"a57d17b0-...","path":"/missions","totalMs":2,"pass":"page-done","segments":{"page:render":2}}
[deptend:timing] {"reqId":"a57d17b0-...","path":"/missions","totalMs":2,"pass":"full","segments":{"page:render":2,"cache:repos":15.6,"cache:missions":15.5,"repos:directory-summary":22.4,"missions:board":25.8}}
```

The 5-table join takes 25.8ms (matches AGENTS.md §2's documented
sub-50ms cost). The `unstable_cache` wrapper takes 15.5ms. The
`repos:directory-summary` call takes 22.4ms including the 1.2ms
cache lookup.

- `pnpm typecheck`, `pnpm test` (198 app tests pass), `pnpm lint --max-warnings 0`,
  `pnpm format:check`, `pnpm build` all pass.
- 8 new unit tests in `app/src/lib/timing/store.test.ts` (request scope,
  concurrency isolation, sync/async variants, error handling, label
  summing, format output).
- Live verification: `pnpm start` + `DEPTEND_TIMING_LOG=1` + `curl` probe
  against the four smoke URLs.

## What did NOT change

- The middleware's `Server-Timing: total;dur=...` header is preserved.
- The `unstable_cache` 60s TTL behavior is unchanged.
- The `force-dynamic` page directive is unchanged.
- No production emission path. The data is in stdout in dev mode (or
  with `DEPTEND_TIMING_LOG=1`); production observability is via a future
  metrics endpoint.
- No cross-request aggregation; the store is per-process and per-request.

## What this ADR does NOT solve (future work)

- The AGENTS.md §12 constraint: response headers cannot be set from
  page renders, and middleware runs before the page render. A real
  fix needs a custom Next.js server (replacing the default request
  handler) that reads the per-request store on the way out, or an
  `instrumentation.ts` hook that runs after the page render.
- The `/` and `/repo/...` pages don't have the helper yet. Same pattern
  as this ADR; decision-point on whether to ship in this PR or a
  follow-up.

## Next steps

- Wire `withRequestStore` + `logTimingsForRequest` into `/` and `/repo/...`
  (same pattern as `/missions`).
- Replace the stdout log with a metrics endpoint (Datadog, OTel, Vercel
  log drain) when the project has one. The data is captured; the
  emission is the only thing to change.
- Deploy to a Vercel preview URL and re-confirm the data flows on real
  infrastructure.
- Consider per-statement SQL timing (Drizzle `onQuery` callback) if
  the 5-table join ever becomes the bottleneck. Currently sub-50ms,
  so the lever is small.
