/**
 * Simplified per-request timing store.
 *
 * Option A (2026-09-06): Lift timing to page level, remove Suspense boundary
 * workaround. The middleware's Server-Timing header (total;dur=...) provides
 * the honest low-risk signal. Per-segment timing from Suspense boundaries
 * was the explicit follow-up flagged in ADR 0052 but cannot work without
 * a custom server or response-body rewriting — both out of scope for the
 * solo-dev budget.
 *
 * What this module does:
 * 1. Provides `withTiming(label, fn)` for read paths to record their work.
 * 2. Uses `currentRequestId()` from `next/headers` to address the right store.
 * 3. Module-level `Map<requestId, TimingStore>` for in-process storage.
 * 4. Middleware reads entries on response side for logging/metrics.
 */

import { headers } from "next/headers";

export interface TimingEntry {
  label: string;
  durMs: number;
}

interface TimingStore {
  entries: TimingEntry[];
}

const REQUEST_ID_HEADER = "x-request-id";

/**
 * Allocate a fresh request id. Called by the middleware on the way in.
 * The id is set on the request headers (read by `next/headers` in the page
 * render) and on the response (for log correlation).
 */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Get the request id from the current request scope. Uses next/headers,
 * so this works from any Server Component. Returns `null` if no request
 * id is in scope.
 */
export async function currentRequestId(): Promise<string | null> {
  try {
    const h = await headers();
    return h.get(REQUEST_ID_HEADER);
  } catch {
    return null;
  }
}

// Test-only export for direct store manipulation
export const stores = new Map<string, TimingStore>();

function getOrCreateStore(requestId: string): TimingStore {
  let s = stores.get(requestId);
  if (s === undefined) {
    s = { entries: [] };
    stores.set(requestId, s);
  }
  return s;
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
 */
export async function withTiming<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const requestId = await currentRequestId();
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
 * Format the accumulated entries as a `Server-Timing` header value.
 * Returns `null` if there are no entries.
 */
export function formatServerTimingEntries(entries: TimingEntry[]): string | null {
  if (entries.length === 0) return null;
  const sums = new Map<string, number>();
  for (const e of entries) {
    sums.set(e.label, (sums.get(e.label) ?? 0) + e.durMs);
  }
  return [...sums.entries()].map(([label, ms]) => `${label};dur=${ms.toFixed(1)}`).join(", ");
}

/**
 * Snapshot the entries for a given request id.
 */
export function readEntries(requestId: string | null = null): TimingEntry[] {
  if (requestId === null) {
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
 * Clear the store map. Used by tests.
 */
export function _resetForTests(): void {
  stores.clear();
}

export { REQUEST_ID_HEADER };
