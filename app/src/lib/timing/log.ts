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

import { readEntries } from "./store";

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
export function logTimingsForRequest(path: string, totalMs: number, reqId: string): void {
  // Skip in production unless explicitly enabled. The default is dev-only
  // because per-request stdout logs are noisy in prod; production should
  // pipe this data to a metrics endpoint (Datadog, OTel, etc.) instead.
  // The `DEPTEND_TIMING_LOG=1` override exists so the round-5 perf
  // series can verify the data is being collected against a `pnpm start`
  // build, which sets `NODE_ENV=production`.
  const isDev = process.env.NODE_ENV !== "production";
  const forceEnabled = process.env.DEPTEND_TIMING_LOG === "1";
  if (!isDev && !forceEnabled) {
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
  });
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
