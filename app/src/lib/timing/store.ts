/**
 * Per-request timing store for the 2026-09-05 perf series round 5.
 *
 * Why this exists
 * ---------------
 * AGENTS.md §12 (Learned Pitfalls) calls out that App Router pages cannot
 * set response headers from a Server Component — `next/headers`'s
 * `headers()` is sealed with a Proxy that throws on `.set()` (see
 * `app/node_modules/next/dist/server/web/spec-extension/adapters/headers.js`).
 * The middleware is the only place that can set response headers, and it
 * runs BEFORE the page render, so it cannot observe per-segment timings
 * that the page render records. This is the structural constraint that
 * ADR 0052's "per-segment Server-Timing" follow-up ran into.
 *
 * What this module does
 * ---------------------
 * 1. Holds a per-request timing store, keyed by request id. The middleware
 *    mints a fresh id on the way in and sets it as the `x-request-id`
 *    header on the request. The page render reads it back via
 *    `next/headers` and uses it to address the right store entry.
 * 2. Provides `withTiming(label, fn)` for the read paths to record their
 *    own work — cache lookup, DB query, hydration prep, etc.
 * 3. Module-level `Map<requestId, TimingStore>` (NOT AsyncLocalStorage)
 *    so the store survives across `<Suspense>` boundaries, which is
 *    important because the data fetches live inside Suspense boundaries
 *    and AsyncLocalStorage does not propagate across them in Next 15.
 * 4. The middleware reads the entries on the way out via the same Map.
 *    In Next 15 middleware, this is `undefined` because the page render
 *    has not yet run, but the data is still in the Map for the response
 *    side. A future iteration can ship the data to a metrics endpoint
 *    from the middleware on the way out, or from a `instrumentation.ts`
 *    hook (see the long-form comment for the full analysis).
 *
 * What's NOT in scope here
 * ------------------------
 * - Cross-request aggregation (that's a logging/metrics job; this store
 *   is intentionally short-lived and per-process).
 * - Timing the JS hydration or the RSC stream assembly. Those happen in
 *   the Next.js server's own pipeline and aren't observable from a
 *   Server Component without platform-level instrumentation.
 * - Timing the `unstable_cache` cache hit/miss itself. `unstable_cache`
 *   doesn't expose its internal timing; `withTiming` measures the
 *   total time for the cached callback (which on a cache hit is the
 *   JSON-deserialization cost, on a miss is the full callback + DB).
 *
 * Why a module-level Map, not AsyncLocalStorage
 * ---------------------------------------------
 * AsyncLocalStorage does not propagate across React's `<Suspense>`
 * boundary children. The data fetches in this project are inside
 * Suspense boundaries (round 3 of the 2026-09-05 perf series), so
 * the AsyncLocalStorage from the page's `withRequestStore` wrapper is
 * not visible to the queries. A module-level Map keyed by request id
 * — read from `next/headers` in each `withTiming` call — does
 * propagate, at the cost of requiring a request id in the headers.
 * The middleware sets it; the data fetches read it. The cost is one
 * synchronous `headers().get()` per data fetch, which is on the order
 * of microseconds.
 */

import { headers } from "next/headers";

export interface TimingEntry {
  label: string;
  durMs: number;
}

interface TimingStore {
  entries: TimingEntry[];
  totalStartNs: bigint;
}

const stores = new Map<string, TimingStore>();

const REQUEST_ID_HEADER = "x-request-id";

/**
 * Allocate a fresh request id. Called by the middleware on the way
 * in. The id is set on the request headers (read by `next/headers` in
 * the page render) and on the response (for log correlation).
 *
 * Uses the global `crypto.randomUUID()` from the Web Crypto API rather
 * than `node:crypto.randomUUID` so the helper can be bundled into the
 * Edge runtime (middleware + future Edge routes) without a Node.js
 * polyfill — Edge doesn't have `node:crypto` and webpack rejects the
 * `node:` import scheme.
 */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Read the request id from a `Headers` instance. Returns `null` if the
 * header isn't set (e.g., the middleware didn't run for this request).
 */
export function readRequestId(headers: Headers): string | null {
  return headers.get(REQUEST_ID_HEADER);
}

/**
 * Get the request id from the current request scope. Uses next/headers,
 * so this works from any Server Component, including Suspense children.
 * Returns `null` if no request id is in scope.
 */
export async function currentRequestId(): Promise<string | null> {
  try {
    const h = await headers();
    return h.get(REQUEST_ID_HEADER);
  } catch {
    return null;
  }
}

/**
 * Get (or lazily create) the timing store for a given request id. If
 * no id is provided, returns `null` (callers must handle).
 */
function getOrCreateStore(requestId: string): TimingStore {
  let s = stores.get(requestId);
  if (s === undefined) {
    s = { entries: [], totalStartNs: process.hrtime.bigint() };
    stores.set(requestId, s);
  }
  return s;
}

/**
 * Set up the request-scoped timing store. Called by the page render
 * at the top of the page function. The store is then available to any
 * code reading it via `getOrCreateStore(await currentRequestId())`,
 * including Server Components inside `<Suspense>` boundaries.
 */
export async function withRequestStore<T>(requestId: string, fn: () => Promise<T> | T): Promise<T> {
  getOrCreateStore(requestId);
  // Set the module-level snapshot so callers in nested async scopes
  // (e.g., a `<Suspense>` boundary's children) can pick up the request
  // id without re-reading `next/headers()`. This is the only way
  // AsyncLocalStorage's per-request scope propagates across the
  // boundary, since AsyncLocalStorage itself does not.
  const previousSnapshot = currentRequestIdSnapshot;
  currentRequestIdSnapshot = requestId;
  try {
    return await fn();
  } finally {
    currentRequestIdSnapshot = previousSnapshot;
  }
}

/**
 * Run `fn` and record how long it took under `label`. Always returns
 * whatever `fn` returns (including throws — the timing is recorded
 * either way). Uses the current request id from `next/headers` to
 * address the right per-request store; if no request id is in scope
 * (e.g., a unit test), the call is a pass-through (no recording).
 *
 * Usage:
 *   const board = await withTiming("board:db", () => getBoardMissionsPage(...))
 *
 * Nested calls are supported; same-label entries are summed. The intent
 * is to compose timing at the query layer, not to attribute per-statement
 * SQL time. A future iteration could add a per-statement timing hook
 * via Drizzle's `onQuery` callback.
 */
export async function withTiming<T>(label: string, fn: () => Promise<T>): Promise<T> {
  // Two-step lookup: prefer the module-level snapshot (set by
  // withRequestStore, which the page render calls at the top of its
  // function) so that data fetches inside <Suspense> boundaries still
  // have a request id. Fall back to async currentRequestId() (which
  // reads from next/headers) when no snapshot is set, e.g. for callers
  // that didn't wrap themselves in withRequestStore.
  const requestId = currentRequestIdSnapshot ?? (await currentRequestId());
  if (requestId === null) {
    return await fn();
  }
  const store = getOrCreateStore(requestId);
  const startNs = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    const endNs = process.hrtime.bigint();
    const durMs = Number(endNs - startNs) / 1e6;
    store.entries.push({ label, durMs: Math.max(0, durMs) });
  }
}

/**
 * Synchronous variant of `withTiming`. Use for non-async work (e.g.,
 * a JSON parse). Same semantics otherwise.
 */
export function withTimingSync<T>(label: string, fn: () => T): T {
  // Sync variant: can't read headers (headers() is async). For
  // synchronous work, callers must wrap in `withTiming` to establish
  // the scope. This is rare in practice.
  const requestId = currentRequestIdSnapshot;
  if (requestId === null) {
    return fn();
  }
  const store = getOrCreateStore(requestId);
  const startNs = process.hrtime.bigint();
  try {
    return fn();
  } finally {
    const endNs = process.hrtime.bigint();
    const durMs = Number(endNs - startNs) / 1e6;
    store.entries.push({ label, durMs: Math.max(0, durMs) });
  }
}

/**
 * Explicit-request-id variant of `withTiming`. Use this when the call
 * site already has the request id (e.g., it was read from
 * `next/headers()` in the page render and passed down as a prop), and
 * the data fetch runs inside a `<Suspense>` boundary where
 * `headers()` is unavailable or returns a different value.
 *
 * This is the path round 5 of the 2026-09-05 perf series ships by
 * default for the data-fetch helpers in `queries/missions.ts`. The
 * `withTiming(label, fn)` form is kept for callers that have
 * `headers()` available in scope.
 */
export async function withTimingFor<T>(
  requestId: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const store = getOrCreateStore(requestId);
  const startNs = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    const endNs = process.hrtime.bigint();
    const durMs = Number(endNs - startNs) / 1e6;
    store.entries.push({ label, durMs: Math.max(0, durMs) });
  }
}

// Snapshot of currentRequestId() for use in withTimingSync. Tests set
// this via _setCurrentRequestIdForTests; production sets it via
// withRequestStore before a code path crosses a Suspense boundary
// (where next/headers() may not be reachable).
let currentRequestIdSnapshot: string | null = null;

/**
 * Format the accumulated entries as a `Server-Timing` header value
 * (the comma-separated part that goes after any existing segment).
 * Returns `null` if there are no entries, so the caller can leave the
 * existing middleware segment alone.
 *
 * Format: `cache;dur=12.3, db;dur=4.5` — milliseconds, 1 decimal
 * (rounded). Sub-millisecond timings are emitted as `<0.1ms` to keep
 * the header short. Same-label entries are summed.
 */
export function formatServerTimingEntries(entries: TimingEntry[]): string | null {
  if (entries.length === 0) return null;
  // Sum same-label entries so a "db" timing that appears twice (e.g.,
  // from two parallel queries) reads as the total.
  const sums = new Map<string, number>();
  for (const e of entries) {
    sums.set(e.label, (sums.get(e.label) ?? 0) + e.durMs);
  }
  return [...sums.entries()].map(([label, ms]) => `${label};dur=${ms.toFixed(1)}`).join(", ");
}

/**
 * Snapshot the entries for a given request id. Used by the dev-mode
 * logger and the test helpers.
 */
export function readEntries(requestId: string | null = null): TimingEntry[] {
  if (requestId === null) {
    // No request id; return the union of all stores (test helper only).
    const all: TimingEntry[] = [];
    for (const s of stores.values()) {
      all.push(...s.entries);
    }
    return all;
  }
  const s = stores.get(requestId);
  return s === undefined ? [] : [...s.entries];
}

/**
 * Manually record a timing entry. Useful for the page render to
 * record its own total time, or for the per-render flush.
 */
export function recordTiming(label: string, durMs: number, requestId?: string): void {
  const id = requestId ?? currentRequestIdSnapshot;
  if (id === null) {
    void currentRequestId().then((resolved) => {
      if (resolved === null) return;
      const store = getOrCreateStore(resolved);
      store.entries.push({ label, durMs: Math.max(0, durMs) });
    });
    return;
  }
  const store = getOrCreateStore(id);
  store.entries.push({ label, durMs: Math.max(0, durMs) });
}

/**
 * Clear the store map. Used by tests; production code never calls this.
 */
export function _resetForTests(): void {
  stores.clear();
  currentRequestIdSnapshot = null;
}

/**
 * Test helper: set the request id for the synchronous `withTimingSync`.
 * Production code never calls this; it exists for tests that don't have
 * an async context.
 */
export function _setCurrentRequestIdForTests(requestId: string | null): void {
  currentRequestIdSnapshot = requestId;
}

export { REQUEST_ID_HEADER };
