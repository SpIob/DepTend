/**
 * Dev-mode stdout logger for the per-request timing store.
 *
 * In production this is a no-op (the data goes to the store, but the
 * per-segment Server-Timing emission is blocked by AGENTS.md §12's
 * App Router constraint — see store.ts). A future iteration that ships
 * the data to a metrics endpoint (Datadog, OpenTelemetry, a custom
 * Vercel log drain) would replace this logger entirely.
 *
 * The log format is one JSON line per request, prefixed with a stable
 * tag so log aggregators can grep for it:
 *
 *   [deptend:timing] {"reqId":"...","path":"/missions","totalMs":203.4,"segments":{"missions:board":11.2,"cache:missions":10.8,"repos:directory-summary":7.1}}
 *
 * `segments` is a flat object keyed by the segment label. Same-label
 * segments are summed (matches the Server-Timing emit format).
 *
 * No PII lives in this log — only timing data and the request id. The
 * request id is a random UUID, not a session token.
 */

import { currentRequestId, deleteStore, readEntries } from "./store";

/**
 * Log the per-segment timing data for the current request to stdout.
 * Intended to be called from a place that has access to the request
 * path — typically a page render. Pages cannot set response headers
 * in App Router, so the only practical emission is via the console
 * for now.
 *
 * The page render returns BEFORE the `<Suspense>` boundary's data
 * fetches complete, so a synchronous log call from the page would miss
 * the per-fetch segments. We schedule a `setImmediate` flush that
 * runs after the current tick and re-reads the store; by then the
 * data fetches have completed and the per-fetch entries are present.
 *
 * If no request scope is active (e.g., a background job), this is a
 * no-op.
 */
export async function logTimingsForRequest(
  path: string,
  totalMs: number,
  reqId: string | null,
): Promise<void> {
  if (reqId === null) {
    // No request id (e.g. background job, or the page render ran before
    // middleware). Nothing to read or clean up.
    return;
  }
  // Skip in production unless explicitly enabled. The default is dev-only
  // because per-request stdout logs are noisy in prod; production should
  // pipe this data to a metrics endpoint (Datadog, OTel, etc.) instead.
  // The `DEPTEND_TIMING_LOG=1` override exists so the round-5 perf
  // series can verify the data is being collected against a `pnpm start`
  // build, which sets `NODE_ENV=production`.
  const isDev = process.env.NODE_ENV !== "production";
  const forceEnabled = process.env.DEPTEND_TIMING_LOG === "1";
  if (!isDev && !forceEnabled) {
    // Production default: no read, no log. The request is over, so its
    // store must not linger either — this delete is what bounds prod
    // growth (the deferred one below only runs on the logging path).
    // A straggler Suspense fetch that completes after this point will
    // re-create the store on write; MAX_STORED_REQUESTS is the flood
    // guard for that race.
    deleteStore(reqId);
    return;
  }
  // First pass: log what's available right after the page render
  // returns (i.e., the synchronous portion: page:render, plus any
  // data fetches that already completed before the page's outer
  // render returned).
  flushLog(path, totalMs, reqId, "page-done");
  // Second pass: after the next event-loop tick, the Suspense data
  // fetches have completed and the per-fetch segments are in the
  // store. The "full" label distinguishes this from the first pass
  // in the log.
  setImmediate(() => {
    flushLog(path, totalMs, reqId, "full");
    // The "full" pass is the last read of this request's store. Without
    // this delete, every request that recorded timings persists its store
    // entry in the module-level Map for the process lifetime (2026-11-02
    // perf audit); see store.ts MAX_STORED_REQUESTS for the other guard.
    deleteStore(reqId);
  });
}

/**
 * Resolve the request id from the current request scope and run
 * logTimingsForRequest. Convenience wrapper for pages that don't
 * otherwise need the request id: `await logRequestTimings("/", 12)` —
 * await is required because currentRequestId() reads next/headers.
 * (logTimingsForRequest's flush is still scheduled, not awaited; the
 * "full" pass lands after the page's outer render returns, same as the
 * explicit-reqId form.)
 */
export async function logRequestTimings(path: string, totalMs: number): Promise<void> {
  await logTimingsForRequest(path, totalMs, await currentRequestId());
}

function flushLog(path: string, totalMs: number, reqId: string, pass: "page-done" | "full"): void {
  const entries = readEntries(reqId);
  if (entries.length === 0 && totalMs < 1) {
    return;
  }
  const segments: Record<string, number> = {};
  for (const e of entries) {
    segments[e.label] = (segments[e.label] ?? 0) + e.durMs;
  }
  const line = JSON.stringify({
    reqId,
    path,
    totalMs: Number(totalMs.toFixed(1)),
    pass,
    segments: Object.fromEntries(
      Object.entries(segments).map(([k, v]) => [k, Number(v.toFixed(1))]),
    ),
  });
  // eslint-disable-next-line no-console
  console.log(`[deptend:timing] ${line}`);
}
