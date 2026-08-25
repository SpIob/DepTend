/**
 * Shared transient-failure retry for outbound ingestor fetches.
 *
 * One policy for every third-party call in this directory, extracted from
 * downstream-dependents.ts's discipline (ADR 0032) so the other callers
 * stop diverging from it: ONE automatic retry after a flat backoff, honoring
 * the server's Retry-After header (capped) when present, then giving up and
 * letting the caller's existing degradation path handle the failure.
 *
 * What counts as transient:
 *   - a thrown fetch (network) error, and
 *   - HTTP 429/500/502/503/504, and
 *   - any non-OK response that carries a usable Retry-After header — GitHub
 *     signals some secondary rate limits as 403 WITH Retry-After, while a
 *     plain 403 (actually forbidden) carries none and is not worth waiting
 *     on.
 *
 * Every attempt additionally carries a deadline (default 30 s, disableable
 * via `timeoutMs: 0`) implemented with AbortSignal.timeout, so a hung socket
 * surfaces as a retryable failure instead of stalling the whole ingestion
 * run — a hang here used to leave repos stuck at ingestionStatus "running"
 * forever, since closeRun only executes on completion. The deadline applies
 * PER ATTEMPT (each attempt gets a fresh signal), and a caller-supplied
 * signal is honored too: if the caller cancels, the failure is NOT retried.
 *
 * Deliberately not a general-purpose HTTP client: no exponential backoff
 * curves, no attempt-count config — one retry, same shape everywhere, so a
 * reader only ever has to learn this once. Tests pass `retryDelayMs: 0`.
 */
export const DEFAULT_RETRY_DELAY_MS = 30_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const MAX_RETRY_AFTER_MS = 120_000;

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export interface FetchRetryOptions {
  /**
   * Flat backoff before the single retry when the response carries no
   * usable Retry-After. Tests pass 0; production keeps the default.
   */
  retryDelayMs?: number;
  /**
   * Per-attempt deadline in milliseconds; each attempt gets a fresh
   * AbortSignal.timeout so a hung socket surfaces as a retryable failure.
   * Default 30 s; explicit 0 disables the deadline entirely (tests stubbing
   * `fetch` don't need it, and a caller that manages its own cancellation
   * can too).
   */
  timeoutMs?: number;
}

export function parseRetryAfterMs(response: Response, maxMs: number): number {
  const header = response.headers.get("retry-after");
  if (header === null) return -1;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return -1;
  return Math.min(seconds * 1_000, maxMs);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-attempt RequestInit: composes the caller's signal (if any) with a
 * fresh per-attempt timeout signal. AbortSignal.any requires Node 20.3+;
 * every runtime this project targets (CI Node 24, local 26, Vercel) clears
 * that by years.
 */
function buildAttemptInit(init: RequestInit | undefined, timeoutMs: number): RequestInit {
  // Deadline disabled — pass the caller's init through untouched rather than
  // rebuilding it with an explicit `signal: undefined` key (which violates
  // exactOptionalPropertyTypes and would differ from a bare fetch call).
  if (timeoutMs <= 0) {
    return init ?? {};
  }
  const callerSignal = init?.signal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    callerSignal != null ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  return { ...init, signal };
}
/**
 * Fetch with exactly one retry on transient failure and a per-attempt
 * deadline. Returns the final response whatever its status — HTTP errors are
 * the caller's problem, same contract as bare fetch. Network errors propagate
 * after the retry fails, except a caller-initiated abort, which propagates
 * immediately (cancelling is not a transient condition worth one more go).
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const callerAborted = (): boolean => init?.signal?.aborted === true;

  const attempt = (): Promise<Response> => fetch(url, buildAttemptInit(init, timeoutMs));

  let response: Response;
  try {
    response = await attempt();
  } catch (err) {
    if (callerAborted()) throw err;
    // Network-level failure — no headers to learn from, flat backoff.
    await sleep(retryDelayMs);
    return await attempt(); // second failure propagates to the caller
  }

  const retryAfterMs = response.ok ? -1 : parseRetryAfterMs(response, MAX_RETRY_AFTER_MS);
  const transient = RETRYABLE_STATUS_CODES.has(response.status) || retryAfterMs >= 0;

  if (!transient) {
    return response;
  }

  // Free the unread body so the failed attempt doesn't hold the connection
  // until GC while we wait.
  if (response.body !== null) {
    response.body.cancel().catch(() => undefined);
  }

  await sleep(retryAfterMs >= 0 ? retryAfterMs : retryDelayMs);

  return await attempt();
}
