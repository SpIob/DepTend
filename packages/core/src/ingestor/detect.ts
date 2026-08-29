/**
 * Ecosystem detection — parallel probing with priority-tie-break (ADR 0041)
 *
 * Fans out every ingestor's parseDependencies() concurrently, so a Go-only
 * repo no longer pays the cost of the npm + pypi probes' wasted round-trips
 * before Go is tried. The caller's array order is the explicit tie-breaker
 * for the rare case where two probes both resolve — npm-first / pypi-second
 * / go-third (ADR 0022 / 0024) is preserved exactly.
 *
 * As soon as a probe resolves with manifest_resolved: true, an AbortController
 * fires on every other in-flight probe, so the OS-level connection for the
 * still-running requests closes instead of completing-and-being-discarded.
 * A probe that rejects (whether from the orchestrator's abort or from a
 * transport failure) is converted to an unresolved result carrying a warning,
 * matching the pre-0041 "one flaky request must not abort detection" rule.
 *
 * The all-fail path (no probe resolved) is unchanged at the public boundary:
 * every attempt's warnings are combined in caller-list order, the final
 * result is the last attempt's payload with manifest_resolved: false, and
 * warnings from orchestrator-initiated aborts are dropped (they were never
 * a real failure — just a winner that already beat them to the post).
 *
 * Settled decisions referenced:
 * - ADR 0022; ordered probing, npm first, then PyPI.
 * - ADR 0024; Go added as a third probed ecosystem, same router.
 * - ADR 0041; parallel probing, AbortController plumbing, priority tie-break.
 *
 * Shared by scripts/ingest.js, the submission manifest pre-check
 * (manifest-check.ts), and the local-*-analyze CLI plumbing, so this logic
 * exists exactly once.
 */

import type { EcosystemIngestor, IngestorResult } from "./interface.js";

/**
 * Sentinel error class used internally to mark an in-flight probe whose
 * AbortController fired because another probe already won. Caught at the
 * per-probe boundary and converted to a synthetic unresolved result; the
 * abort-vs-transport distinction is what decides whether the warning ever
 * makes it to the final all-fail result.
 */
class ProbeAbortedError extends Error {
  constructor() {
    super("Probe was aborted by orchestrator after a higher-priority probe won.");
    this.name = "ProbeAbortedError";
  }
}

function isProbeAbortedError(err: unknown): err is ProbeAbortedError {
  return err instanceof ProbeAbortedError;
}

/**
 * Runs every ingestor in parallel, aborting the in-flight losers as soon as
 * a probe resolves with manifest_resolved: true. On a tie (multiple probes
 * resolved close enough that all promises were already in-flight before the
 * first settled), the lowest-index probe in the caller's list wins — the
 * same priority order the pre-0041 sequential path enforced.
 */
async function runProbes(
  ingestors: EcosystemIngestor[],
  repoPath: string,
  controller: AbortController,
): Promise<{ result: IngestorResult; index: number }[]> {
  if (ingestors.length === 0) return [];

  const signal = controller.signal;

  const probePromises = ingestors.map(async (ingestor, index) => {
    let result: IngestorResult;
    try {
      result = await ingestor.parseDependencies(repoPath, signal);
    } catch (err) {
      // Orchestrator-initiated abort (a higher-priority probe won): do not
      // surface as a failure. Re-raise the sentinel so the per-probe
      // boundary catches it without writing a warning.
      if (isProbeAbortedError(err) || signal.aborted) {
        throw err instanceof Error ? err : new ProbeAbortedError();
      }
      // Real transport failure: convert to unresolved with a warning, same
      // shape as the pre-0041 sequential path.
      result = {
        ecosystem: ingestor.ecosystem,
        dependencies: [],
        lock_file_present: false,
        manifest_resolved: false,
        warnings: [
          `${ingestor.ecosystem} probe failed and was skipped: ${String(err)}` +
            " — falling through to the next ingestor.",
        ],
      };
    }
    return { result, index };
  });

  /**
   * Promise.allSettled with a tie-break: collect results as they arrive,
   * pick the lowest-index winner, abort the rest. Avoids Promise.race's
   * first-to-settle-wins semantics, which would let a slow-but-lower-priority
   * probe lose on a fast-but-higher-priority one.
   */
  return new Promise((resolve) => {
    const settled: { result: IngestorResult; index: number }[] = [];
    let winner: { result: IngestorResult; index: number } | null = null;
    let pending = ingestors.length;

    const onSettle = (entry: { result: IngestorResult; index: number }): void => {
      pending--;
      settled.push(entry);

      if (winner === null && entry.result.manifest_resolved) {
        // First winner claim. Lower-index probes that also resolve later
        // are ignored once a winner is set; losers are aborted below.
        winner = entry;
        controller.abort();
      }

      if (pending === 0) {
        resolve(settled);
      }
    };

    probePromises.forEach((promise, i) => {
      promise
        .then((entry) => {
          onSettle(entry);
        })
        .catch((err: unknown) => {
          // Orchestrator-initiated abort: drop without a warning. A
          // higher-priority probe already claimed the winner slot; this
          // probe is just being told to stop.
          if (isProbeAbortedError(err) || signal.aborted) {
            onSettle({
              result: {
                ecosystem: ingestors[i]?.ecosystem ?? "npm",
                dependencies: [],
                lock_file_present: false,
                manifest_resolved: false,
                warnings: [],
              },
              index: i,
            });
            return;
          }
          // An unexpected error escaped the per-probe try/catch. Treat as
          // an unresolved result with a warning so detection continues.
          const ingestor = ingestors[i];
          const ecosystem = ingestor?.ecosystem ?? "npm";
          onSettle({
            result: {
              ecosystem,
              dependencies: [],
              lock_file_present: false,
              manifest_resolved: false,
              warnings: [
                `${ecosystem} probe failed unexpectedly: ${String(err)} — falling through.`,
              ],
            },
            index: i,
          });
        });
    });
  });
}

/**
 * Tries every ingestor's parseDependencies(repoPath) in parallel and returns
 * the first one to settle with manifest_resolved: true. Ties are broken by
 * caller-list index (lower index wins), preserving the pre-0041
 * "first-listed wins" priority contract (ADR 0022 / 0024). In-flight losers
 * are aborted as soon as a winner is determined.
 *
 * A probe that THROWS (a transient network error, an unexpected HTTP status,
 * an AbortError) is converted to an unresolved result carrying the error as
 * a warning, exactly like the pre-0041 sequential path. Orchestrator-
 * initiated aborts (a higher-priority probe won while this one was still
 * in flight) are silently dropped — they were never a verdict about the
 * repo, just a winner that beat them to the post.
 *
 * @param ingestors - tried in parallel; the caller controls probing priority
 *   by the order it passes ingestors in (ADR 0022: npm first, then PyPI,
 *   then Go per ADR 0024). Ties are broken by this same array order.
 * @param repoPath - passed through to each ingestor unchanged — a GitHub
 *   raw content base URL for HTTP-based ingestors, or a local filesystem
 *   path for filesystem-based ones. Every ingestor passed in must accept
 *   the same kind of repoPath; the router itself has no opinion on which.
 */
export async function detectEcosystem(
  ingestors: EcosystemIngestor[],
  repoPath: string,
): Promise<IngestorResult> {
  if (ingestors.length === 0) {
    return {
      ecosystem: "npm",
      dependencies: [],
      lock_file_present: false,
      manifest_resolved: false,
      warnings: ["detectEcosystem() was called with an empty ingestors list."],
    };
  }

  const controller = new AbortController();
  const attempts = await runProbes(ingestors, repoPath, controller);

  // Find the lowest-index winner, if any. Even if a higher-index probe
  // resolved first by wall clock, the lower-index one wins on tie.
  let winnerEntry: { result: IngestorResult; index: number } | null = null;
  for (const attempt of attempts) {
    if (attempt.result.manifest_resolved) {
      if (winnerEntry === null || attempt.index < winnerEntry.index) {
        winnerEntry = attempt;
      }
    }
  }

  if (winnerEntry !== null) {
    return winnerEntry.result;
  }

  // All probes failed. Return the last attempt's payload with every attempt's
  // warnings combined in caller-list order — orchestrator-initiated aborts
  // contribute no warnings (their `warnings: []` slot in the synthetic result
  // filters them out naturally).
  const last = attempts[attempts.length - 1];
  if (last === undefined) {
    return {
      ecosystem: "npm",
      dependencies: [],
      lock_file_present: false,
      manifest_resolved: false,
      warnings: ["detectEcosystem() completed with no probe attempts recorded."],
    };
  }

  return {
    ...last.result,
    warnings: attempts.flatMap((attempt) => attempt.result.warnings),
  };
}
