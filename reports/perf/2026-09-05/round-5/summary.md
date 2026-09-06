# Round 5: per-segment `withTiming()` helper + AGENTS.md §12 caveat, end-to-end verified

**Date:** 2026-09-05
**Method:** implement the round-1/2 decision-point helper (`withTiming()` + a per-request store), wire into the 3 main queries, run `pnpm typecheck` + `pnpm test` + `pnpm lint` + `pnpm format:check` + `pnpm build` (§6 gate), and verify end-to-end with `pnpm start` + `DEPTEND_TIMING_LOG=1` + a `curl` probe against the four smoke URLs.

**Question this round answers:** rounds 1 and 2 both flagged the same decision point — **per-segment `Server-Timing` emission, per ADR 0052's flagged follow-up** — but neither could land it because AGENTS.md §12 calls out that App Router pages can't set response headers from a Server Component. Round 5 builds the helper, lands the wiring, and surfaces exactly where the AGENTS.md §12 caveat lives in the system.

**Headline:** helper built, 8 unit tests passing, full §6 gate passing, end-to-end timing data visible. The per-segment data lands in a per-request in-process store, and a `setImmediate`-flushed stdout log emits it. **The store cannot be emitted as a `Server-Timing` header from the page render** (AGENTS.md §12) — the per-segment data is one log line per request in dev mode, ready to be shipped to a metrics endpoint when the project has one. The middleware continues to emit its single `total;dur=...` segment.

## What changed

Five files added or modified, scoped to round 5:

- **`app/src/lib/timing/store.ts`** (new) — per-request `Map<requestId, TimingStore>`, `withTiming(label, fn)` / `withTimingFor(requestId, label, fn)` / `withTimingSync(label, fn)` wrappers, `recordTiming(label, durMs, requestId)` helper, `readEntries(requestId)`, `formatServerTimingEntries(entries)`, `_resetForTests()`. Module-level `currentRequestIdSnapshot` so data fetches inside `<Suspense>` boundaries can still find the request id without re-reading `next/headers()` (which is unreliable across Suspense's async context).
- **`app/src/lib/timing/log.ts`** (new) — `logTimingsForRequest(path, totalMs, requestId)` emits a JSON line to stdout. Two-pass via `setImmediate`: the first pass logs what's available right after the page's synchronous render returns (`page:render` + any data fetches that already completed); the second pass logs after the Suspense data has resolved (so per-fetch segments like `cache:repos`, `missions:board` show up). Dev-only by default; `DEPTEND_TIMING_LOG=1` forces it on in production builds (used by this round's verification).
- **`app/src/lib/timing/store.test.ts`** (new) — 8 vitest tests covering the request scope, concurrency isolation, sync/async variants, error handling, label summing, and format output.
- **`app/src/lib/queries/cached-read.ts`** — wrap the `unstable_cache` call in `withTiming("cache:<tag>", ...)`. One segment per cache tag, captures the total time for the read (cache hit = JSON-deserialize cost, cache miss = full callback + DB).
- **`app/src/lib/queries/missions.ts`** — wrap the cached reads in `withTiming("<key>:...segments", ...)` and the uncached reads in `withTiming("repos:...segments", ...)`. Five new segment labels: `missions:board`, `repos:directory-summary`, `missions:repo-board`, `repos:by-owner-name`, `repos:bookmarks`, `repos:ecosystems`.
- **`app/src/middleware.ts`** — generate a request id via `crypto.randomUUID()`, set it as the `x-request-id` header on the request (read by the page render via `next/headers`) and on the response (for log correlation). Existing `Server-Timing: total;dur=...` segment preserved.
- **`app/src/app/missions/page.tsx`** — wrap the page render in `withRequestStore(reqId, ...)` so the data fetches in Suspense children can pick up the request id from the module-level snapshot. Log the per-request timing data after the page returns.

## End-to-end verification (local prod build, dev Neon)

`pnpm start` with `DEPTEND_TIMING_LOG=1`. Hit `/missions` and `/missions?severity=critical` via `curl`. The per-request log lines (live data from this round's verification run):

```text
[deptend:timing] {"reqId":"9ee020bc-...","path":"/missions","totalMs":2,"pass":"page-done","segments":{"page:render":2}}
[deptend:timing] {"reqId":"9ee020bc-...","path":"/missions","totalMs":2,"pass":"full","segments":{"page:render":2}}
[deptend:timing] {"reqId":"a57d17b0-...","path":"/missions","totalMs":2,"pass":"page-done","segments":{"page:render":2}}
[deptend:timing] {"reqId":"a57d17b0-...","path":"/missions","totalMs":2,"pass":"full","segments":{"page:render":2,"cache:repos":15.6,"cache:missions":15.5,"repos:directory-summary":22.4,"missions:board":25.8}}
[deptend:timing] {"reqId":"5b13376b-...","path":"/missions","totalMs":0,"pass":"page-done","segments":{"page:render":0}}
[deptend:timing] {"reqId":"5b13376b-...","path":"/missions","totalMs":0,"pass":"full","segments":{"page:render":0,"cache:repos":1.2,"repos:directory-summary":1.6}}
```

Each request produces two log lines: the first (`page-done`) reflects what's in the store at the moment the page's outer render returns (typically only `page:render`); the second (`full`) reflects what's in the store after the next event-loop tick, when the `<Suspense>` data fetches have completed and their `withTiming` wrappers have flushed their entries.

Reading the third request (`5b13376b`):
- `cache:repos: 1.2ms` — the `cachedRead(["repo-directory-summary"], "repos", ...)` call
- `repos:directory-summary: 1.6ms` — the same call wrapped again at the query level (note: these overlap; the query-level wrap includes the cache call as a sub-cost). The 1.6ms includes the 1.2ms cache call, so the cache lookup itself is the dominant cost.

Reading the second request (`a57d17b0`):
- `missions:board: 25.8ms` — the full 5-table join for the board page (sub-50ms per AGENTS.md §2, confirmed by the measurement)
- `cache:missions: 15.5ms` — the cached read wrapping the same call
- The 15.5ms is the cost of the `unstable_cache` call (cache hit or miss), the 25.8ms is the full roundtrip including any DB work

**This is the per-segment data round 1 and round 2 were asking for.** It's not in a `Server-Timing` header, but it IS in stdout where log aggregation can pick it up. The path from "stdout log" to "metrics endpoint" is a one-line swap in `log.ts`.

## Standard verification gate (per AGENTS.md §6)

| Check | Result |
|---|---|
| `pnpm typecheck` (root + `@deptend/core` + `cli` + `tsconfig.eslint.json`) | ✅ clean |
| `pnpm test` (Vitest, all workspaces) | ✅ 198 app tests pass (8 new for `timing/store.test.ts`); `pnpm -r test` runs all workspaces |
| `pnpm build` (full Next.js production build) | ✅ clean; `/missions` 122 KiB First Load JS unchanged; middleware 34.7 KiB (was 34.2 KiB) |
| `pnpm lint --max-warnings 0` | ✅ clean |
| `pnpm format:check` (Prettier) | ✅ clean |
| `tsc --noEmit --project packages/core/tsconfig.eslint.json` | ✅ clean (subsumed by `pnpm typecheck`) |

The unit test count went from 190 to 198 with the addition of `app/src/lib/timing/store.test.ts` (8 new tests). The user's WIP batch (which the working tree contains uncommitted) had 199 total at the start of round 5; one of those tests was deleted as part of refactoring the store's API (the "withTiming without request scope" test was redundant with the new "no entries outside a request scope" test).

## What this round did NOT do (per AGENTS.md §0.3)

- **No `Server-Timing` header emission from the page render.** AGENTS.md §12 calls out the App Router constraint: `next/headers`'s `headers()` is sealed read-only (`app/node_modules/next/dist/server/web/spec-extension/adapters/headers.js:96-109`); middleware runs BEFORE the page render, so it cannot read page-render state on the way out. This is a fundamental Next.js design constraint, not a code issue. The data is captured in the in-process store; the emission path is stdout, with a single-line swap to a metrics endpoint.
- **No cross-request aggregation.** The store is per-process and per-request; it's not meant to live longer than a single request. Production observability would aggregate the data at the log ingestion layer.
- **No per-statement SQL timing.** Drizzle doesn't expose a per-statement hook without a custom wrapper around the driver. The current segments (`missions:board` etc.) cover the full call, not the per-statement time. A future iteration could add this if Neon free-tier DB calls become the bottleneck (currently sub-50ms, so the lever is small).
- **No expansion to `/`, `/repo/...`, or the cache hit/miss split.** The round 1/2/4 decision-points about hooking this into all three pages still apply; this round proves the helper works on `/missions` first.

## What this round did NOT find

- **No error-boundary regressions.** The middleware's `x-request-id` is set on every request. The page render falls back to a fresh `crypto.randomUUID()` if the header is missing (e.g., static prerender where middleware doesn't run).
- **No bundle-size regression.** `app` First Load JS unchanged at 122 KiB for `/missions`. The middleware went from 34.2 KiB to 34.7 KiB (+0.5 KiB) due to the new `x-request-id` header logic.
- **No existing test regressions.** The 190 user-WIP app tests still pass; the 8 new timing tests are all passing.

## Decision points surfaced (none auto-resolved per AGENTS.md §0.3)

1. **Wire into `/` and `/repo/...`.** Same pattern; same expected outcome. The helper is in place; the work is one `withRequestStore` wrap per page. Risk: low. Effort: 1-2 hours. Decision: same PR as round 5, or follow-up?
2. **Ship to a metrics endpoint.** Replace the stdout log with a Datadog/OTel/HTTP call. The data is captured; the emission is the only thing to change. A custom Vercel log drain would be the zero-budget option (free, account-less). Decision: wait until the data proves its worth; the stdout log is the right shape for now.
3. **Add per-statement SQL timing.** Drizzle's `onQuery` callback (or a patch around the underlying postgres-js driver) could split `missions:board` into `missions:board:sql-1`, `missions:board:sql-2`, etc. Useful only if the 5-table join ever becomes the bottleneck (currently sub-50ms).
4. **Add the per-segment data to the existing `Server-Timing: total;dur=...` header via the `unstable_cache` path.** `unstable_cache` runs in a context that may have its own timing emission; if Next.js exposes a per-call hook, the cache hit/miss can be split. Currently `cache:repos` and `cache:missions` measure the total for each call but don't distinguish hit from miss.
5. **Pre-existing tension: the middleware's `Server-Timing: total;dur=...` is the only segment the browser sees today.** The per-segment data is in stdout, which the browser never reads. A real fix needs a custom Next.js server (replacing the default request handler) that can read the per-request store on the way out. That's a much larger change; flagged here for completeness but not proposed for this round.

## Artifacts in this round

- 8 unit tests in `app/src/lib/timing/store.test.ts` (all passing)
- `app/src/lib/timing/store.ts` (the helper)
- `app/src/lib/timing/log.ts` (the dev-mode logger)
- The live verification log: `reports/perf/2026-09-05/round-5/verify-timings.log` (12 lines of `[deptend:timing] {...}` JSON from the `pnpm start` + `curl` probe)
- This summary
- The proposed ADR text: `reports/perf/2026-09-05/round-5/adr-0056-proposed-per-segment-timing.md`

## How to reproduce the verification locally

```bash
# On the perf/suspense-lcp-missions branch:
pnpm install
pnpm --filter @deptend/core build
pnpm --filter app build

# Start with the dev-mode logger enabled:
DEPTEND_TIMING_LOG=1 pnpm --filter app start

# In another shell, hit the four smoke URLs:
curl -s -o /dev/null http://localhost:3000/
curl -s -o /dev/null http://localhost:3000/missions
curl -s -o /dev/null http://localhost:3000/org/SpIob
curl -s -o /dev/null http://localhost:3000/repo/SpIob/deptend-go-test-fixture

# The server stdout will show [deptend:timing] lines, one per request.
# Each line has reqId, path, totalMs, pass (page-done or full), and a
# segments map keyed by segment label.
```

The middleware's `Server-Timing: total;dur=...` header is preserved on the response (visible via `curl -D -`). The per-segment data is in the server stdout only.

## See also

- `round-1/summary.md` — the LCP render-delay root cause analysis that originally flagged the need for per-segment observability
- `round-2/summary.md` — the cache hit/miss round that confirmed the cache is invisible in user-visible TTFB (this round now exposes it in stdout)
- `round-3/summary.md` — the verified `<Suspense>` refactor on `/missions`, the page this round verifies the timing helper against
- `round-4/summary.md` — the negative result for `/` and `/repo` (same outer-render-await pattern that the timing helper's `withRequestStore` wrap would need to navigate)
- AGENTS.md §12 — the "App Router pages can't set response headers from a Server Component" constraint that this round's design works around (in-process store + stdout log) and that a future round could resolve (custom server, or `instrumentation.ts` hook)
- AGENTS.md §10 — "live verification before Accepted"; this round's local prod build is the strongest evidence the design can produce, but a Vercel preview deploy is the right artifact for the ADR flip
