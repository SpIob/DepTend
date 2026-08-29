/**
 * Bounded-concurrency worker pool.
 *
 * Three different registry fetchers (registry.ts, pypi-registry.ts,
 * go-registry.ts) plus one OSV stage (osv.ts::fetchFullDetails) used to
 * spell out the same hand-rolled semaphore:
 *
 *     let running = 0;
 *     const queue: (() => Promise<void>)[] = [];
 *     const runNext = async () => { ... };
 *     const enqueue = (task) => { ... };
 *
 * with subtle shape differences per site. That's the same pattern of
 * duplication that hid the `$$1` SQL footgun in queries.test.ts
 * (AGENTS §12): four near-identical copies means a fix lands in three of
 * them and the fourth silently keeps the old shape. This helper is the
 * single source of truth — the result-array index pattern (input index
 * equals result index) is preserved so callers don't lose the
 * "which input this result came from" guarantee they had inline.
 *
 * Errors propagate per item: a rejection in one worker does not abort
 * the others. Callers that want to collect failures alongside successes
 * (the three registry fetchers) should have the worker return a
 * discriminated union and split the results afterwards, not throw.
 */

export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = new Array<R>(items.length);
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  let index = 0;

  const runOne = async (): Promise<void> => {
    while (index < items.length) {
      const current = index++;
      const item = items[current];
      if (item === undefined) continue;
      results[current] = await worker(item, current);
    }
  };

  await Promise.all(Array.from({ length: effectiveLimit }, () => runOne()));
  return results;
}
