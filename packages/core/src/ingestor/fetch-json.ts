/**
 * fetch + JSON parse, with the shared retry policy.
 *
 * The shape that used to be inlined in every third-party call in this
 * directory: `fetchWithRetry` → check `!response.ok` → throw → `response.json()`.
 * The two on-success shapes vary per call site (one returns a typed object,
 * one returns a parsed body for further validation, etc.), so this helper
 * is intentionally minimal: it owns the network error → thrown Error and
 * the !response.ok → thrown Error paths, and leaves status-code-specific
 * typed-error classification to the caller via `classifyStatus` if needed.
 *
 * `fetchWithRetry` itself stays untouched — it's the smaller primitive
 * that this helper composes with.
 */

import { fetchWithRetry, type FetchRetryOptions } from "./fetch-retry.js";

export interface FetchJsonError {
  kind: "network" | "http";
  status?: number;
  message: string;
}

/**
 * Some callers need to translate specific non-OK responses into typed
 * errors (e.g. 404 → "not_found", 429 → "rate_limited") before the
 * generic http error path runs. The classifier may either return a
 * string (used as the thrown error's message) or throw any Error
 * subclass — the latter preserves typed-error `instanceof` checks
 * (see github-meta.ts's GitHubMetaError, which classifies 404 and
 * 429 into a subclass carrying a `kind` discriminator). Returning
 * undefined falls through to the default behavior.
 */
export type StatusClassifier = (response: Response) => string | undefined | Promise<never>;

export async function fetchJson<T>(
  url: string,
  init: RequestInit | undefined,
  options: {
    fetchOptions?: FetchRetryOptions;
    /** Override or annotate the default error message. */
    errorPrefix?: string;
    /** Translate specific non-OK responses into typed errors. */
    classifyStatus?: StatusClassifier;
  } = {},
): Promise<T> {
  const { fetchOptions, errorPrefix, classifyStatus } = options;
  const prefix = errorPrefix ?? "fetchJson";

  let response: Response;
  try {
    response = await fetchWithRetry(url, init, fetchOptions);
  } catch (err) {
    throw new Error(`${prefix} — network error: ${String(err)}`);
  }

  if (classifyStatus !== undefined) {
    // Classifier may return a string OR throw a typed error of its
    // choosing. Awaiting the call (even when sync-returning) lets a
    // classifier throw async without us having to special-case it.
    await classifyStatus(response);
  }

  if (!response.ok) {
    throw new Error(
      `${prefix} — HTTP ${String(response.status)}: ${response.statusText || "no status text"}`,
    );
  }

  try {
    return (await response.json()) as T;
  } catch (err) {
    throw new Error(`${prefix} — failed to parse JSON response: ${String(err)}`);
  }
}
