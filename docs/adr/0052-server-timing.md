# ADR 0052: Server-Timing header for production observability

**Status:** Accepted
**Date:** 2026-08-30

---

## Context

The 5-round performance test series on 2026-08-30 (`reports/perf/2026-08-30/compare.md`) found that the 60 s `unstable_cache` cache-hit vs cache-miss gap is **invisible at every measurement layer we have today**:

- **Lighthouse `server-response-time` audit**: warm=36 ms, cold=37 ms — within noise.
- **curl TTFB**: identical cold vs warm (180 ms either way), because each curl process pays the full TLS+connect+HTTP/2 setup, dwarfing the 5-table join.
- **No production HTTP header** surfaces the cache state. A `Server-Timing` segment with `cache;desc=hit` or `cache;dur=37.2` would let production monitoring (Vercel Analytics, browser DevTools, custom probes) observe the actual cache-hit ratio over time without lab runs.

Without this signal, future ADRs that tune the cache TTL (60 s → 30 s, or → 5 min), migrate to a different cache primitive, or fix a cache-warming regression are flying blind. Lab runs are not a substitute: they sample one request at one moment and don't tell you what 99 % of real traffic sees.

The transparency-first non-negotiable from AGENTS.md §1 also argues for surfacing this in production responses: the cache state is internal infrastructure detail, but the page's _measured_ cost is something a curious operator (or a future maintainer) should be able to see directly.

## Decision

Emit a `Server-Timing` response header on every non-asset response, set in `app/src/middleware.ts`. Single segment in this iteration:

```
Server-Timing: total;dur=2.3
```

`total` is the wall-clock time from middleware entry to response build. Rounded to 1 decimal of milliseconds.

Always-on, no env-var gate, no per-route opt-in. AGENTS.md §1's transparency-first principle means this is a public, useful diagnostic — gating it would defeat the purpose.

## Why middleware and not a per-page hook

In Next.js 15 App Router, only middleware and route handlers can set response headers. Page components (`page.tsx`) run inside Next's response pipeline and don't have direct access to the `NextResponse` object. So the only honest choice for a header that lives on every page is middleware.

This means **the recorded duration is the middleware phase only** — nonce generation, CSP build, `NextResponse.next()` setup. It is NOT the full request duration. The page render that happens after `middleware()` returns is outside the timer. The honest name is `total` for "total middleware work"; the segment description in the code is explicit that this excludes the page render and DB queries.

## Why one segment, not per-segment

The plan originally called for three segments — `unstable_cache`, `db`, `render` — set by per-read-path timing hooks. That turns out to be **architecturally impossible in Next 15 App Router middleware**:

- The read paths run inside the page render, which happens _after_ middleware returns.
- Middleware cannot read AsyncLocalStorage state set during the page render; the response object it returns is built before the page renders.
- `unstable_after` (Next 15) runs _after_ the response is sent; it cannot mutate response headers either.
- A route handler (`route.ts`) can return a `NextResponse` directly, but pages can't.

So per-segment Server-Timing in App Router requires either (a) wrapping every page in a route handler, (b) a custom Next.js server, or (c) post-response instrumentation that writes to a separate logging sink instead of a response header. All three are out of scope for a single ADR and a single commit.

The single `total` segment is the **honest, low-risk first step**. It surfaces a real signal (the middleware-phase cost is non-trivial on every page that does CSP work) and sets the stage for per-segment timing in a follow-up if/when the App Router architecture changes.

## Implementation

### `app/src/middleware.ts`

```ts
export function middleware(request: NextRequest): NextResponse {
  const startedAt = performance.now();
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce);

  // ... existing CSP / Permissions-Policy / Referrer-Policy work ...

  const elapsedMs = performance.now() - startedAt;
  response.headers.set("Server-Timing", `total;dur=${elapsedMs.toFixed(1)}`);

  return response;
}
```

The `startedAt` clock is at the very top of the function so it covers nonce generation, CSP build, and `NextResponse.next()` setup. It does NOT cover the page render — that's documented in the file header.

### What didn't change

- `app/src/lib/queries/cached-read.ts` — no per-read timing hook. The 60 s `unstable_cache` cache-hit/miss gap remains unobserved at the response level for now.
- `app/src/lib/queries/missions.ts` — no instrumentation.
- No `instrumentation.ts` was added. The standard Next.js hook is for app initialization (logging, error reporting), not per-request timing.
- No new dependencies. `performance.now()` is a Web Platform API available in the Node.js runtime since v16.

## Consequences

**Positive.**

- A real production signal: every response now carries its middleware-phase duration. Operators can `curl -I https://deptend.vercel.app/...` and see it.
- Future monitoring tools (Vercel Analytics, custom dashboards) can read the header without code changes on the consumer side.
- The header is small (`<30` bytes typically), and the `dur` value is well under 1 ms on the hot path, so no measurable bandwidth or latency cost.
- The header is set unconditionally, so a regression in middleware cost (e.g. someone adds an expensive sync operation there) is now visible in the same `curl` that catches CSP regressions.

**Negative.**

- The single `total` segment is only the middleware phase. A user looking at the header and inferring "this is the page's server time" will be wrong. The file header and this ADR are explicit about the scope; the segment is named `total` because that's what Next.js's `unstable_cache` etc. use by convention, not because it covers everything.
- No per-cache-state signal. The 5-table join is still invisible from production HTTP responses. A follow-up ADR + commit is needed to add per-segment timing if/when the App Router architecture allows it.

**Open question / future work.**

- A follow-up ADR proposing per-segment timing. Two paths worth exploring:
  1. **Wrap pages in a route handler.** Each `page.tsx` becomes a thin shim that calls a `route.ts` handler which can set the header. Significant refactor; likely not worth it for a single header.
  2. **AsyncLocalStorage + a custom Next.js server.** Set timings during page render into AsyncLocalStorage; have a post-response hook (e.g. a custom server's response wrapper) read them and write the header. Also significant.
  3. **A side-channel: log timings to stdout.** Vercel captures stdout; a structured log line per request with cache-hit and DB-time segments would give the same observability without trying to fight the App Router's response-header model. The trade-off: it's not in-band on the response, so external probes don't see it.
- The follow-up is explicitly NOT in this ADR. The decision here is "ship the total segment, document the limit, accept that the 5-table-join cost remains invisible from HTTP." If the operational need is real (e.g. future cache-TTL tuning), a follow-up ADR can pick one of the three paths.

## Verification

- The header is present in `curl -I https://deptend.vercel.app/...` output for every non-asset URL.
- The `dur` value is in the expected range (sub-millisecond to a few milliseconds).
- The header is absent on `/_next/static/*` and `/favicon.ico` (per the existing `matcher` in `app/src/middleware.ts:122-126`).
- AGENTS.md §12 gets a one-line addition: any new middleware-phase work that could be expensive (sync crypto, sync I/O) should be timed or hoisted out of the hot path because its cost is now visible in every response.
