/**
 * Shared Pagination, Pacing, and Retry Logic
 *
 * Used by changelog-signals.ts and downstream-dependents.ts for:
 *   - GitHub Releases pagination (max pages, per-page size)
 *   - libraries.io projects pagination
 *   - Client-side rate limit pacing
 *   - Transient failure retry via fetchWithRetry
 */

import { fetchWithRetry, type FetchRetryOptions } from "../ingestor/fetch-retry.js";

export interface PaginationConfig {
  maxPages: number;
  perPage: number;
  /** Minimum interval between requests (ms) for client-side pacing */
  minIntervalMs?: number;
}

export interface PaginatedFetchOptions extends FetchRetryOptions {
  /** Override pagination config for testing */
  pagination?: Partial<PaginationConfig>;
  /** Request init options passed to fetch */
  init?: RequestInit;
  /** Prefix for error messages */
  errorPrefix?: string;
}

export interface PageResult<T> {
  kind: "ok";
  items: T[];
  /** True if this page is the last (fewer items than perPage) */
  isLastPage: boolean;
}

export interface ErrorPageResult {
  kind: "not-found" | "http-error" | "network-error" | "malformed";
  status?: number;
  reason?: string;
}

export type FetchPageResult<T> = PageResult<T> | ErrorPageResult;

/**
 * Default pagination config - tuned for GitHub Releases and libraries.io
 */
export const DEFAULT_PAGINATION: PaginationConfig = {
  maxPages: 5,
  perPage: 100,
  minIntervalMs: 1_100,
};

/**
 * Module-level pacing state for sequential calls within a process.
 * Used by downstream-dependents.ts (single process, sequential repos).
 */
let lastCallAt = 0;

export function resetPacing(): void {
  lastCallAt = 0;
}

async function pace(minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  const now = Date.now();
  const earliestAllowed = lastCallAt + minIntervalMs;
  if (now < earliestAllowed) {
    await new Promise((resolve) => setTimeout(resolve, earliestAllowed - now));
  }
  lastCallAt = Date.now();
}

/**
 * Fetches all pages from a paginated API endpoint.
 *
 * @param baseUrl - URL with placeholder for page number (e.g., "...&page={page}")
 * @param config - Pagination config
 * @param fetchOptions - fetchWithRetry options
 * @param transform - Optional transform for each page's raw response
 * @returns Aggregated items, or error result if incomplete
 */
export async function fetchAllPages<T>(
  baseUrl: string,
  config: PaginationConfig = DEFAULT_PAGINATION,
  fetchOptions: PaginatedFetchOptions = {},
  transform?: (raw: unknown) => T[],
): Promise<{ items: T[]; truncated: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  const allItems: T[] = [];
  let truncated = false;

  for (let page = 1; page <= config.maxPages; page++) {
    await pace(config.minIntervalMs ?? 0);

    const url = baseUrl.replace("{page}", String(page));
    let response: Response;

    try {
      const options: FetchRetryOptions = {};
      if (fetchOptions.retryDelayMs !== undefined) options.retryDelayMs = fetchOptions.retryDelayMs;
      if (fetchOptions.timeoutMs !== undefined) options.timeoutMs = fetchOptions.timeoutMs;
      if (fetchOptions.maxRetryAfterMs !== undefined)
        options.maxRetryAfterMs = fetchOptions.maxRetryAfterMs;

      response = await fetchWithRetry(url, fetchOptions.init, options);
    } catch {
      return {
        items: [],
        truncated: true,
        warnings: ["Network error during paginated fetch"],
      };
    }

    if (response.status === 404) {
      return { items: allItems, truncated: false, warnings: [] };
    }

    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        return {
          items: allItems,
          truncated: true,
          warnings: [`Rate limited (HTTP ${String(response.status)}) - scan incomplete`],
        };
      }
      return {
        items: allItems,
        truncated: true,
        warnings: [`HTTP ${String(response.status)} - scan incomplete`],
      };
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return {
        items: allItems,
        truncated: true,
        warnings: ["Failed to parse JSON response - scan incomplete"],
      };
    }

    if (!Array.isArray(raw)) {
      return {
        items: allItems,
        truncated: true,
        warnings: ["Response was not an array - scan incomplete"],
      };
    }

    const items = transform ? transform(raw as unknown) : (raw as T[]);
    allItems.push(...items);

    if (items.length < config.perPage) {
      break;
    }

    if (page === config.maxPages) {
      truncated = true;
      warnings.push(
        `Page cap (${String(config.maxPages)}) hit with full page - scan may be incomplete`,
      );
    }
  }

  return { items: allItems, truncated, warnings };
}

/**
 * Builds a GitHub Releases API URL for a repo.
 */
export function buildGitHubReleasesUrl(owner: string, name: string, perPage: number): string {
  return (
    `https://api.github.com/repos/${encodeURIComponent(owner)}/` +
    `${encodeURIComponent(name)}/releases?per_page=${String(perPage)}&page={page}`
  );
}

/**
 * Builds a libraries.io projects API URL for a repo.
 */
export function buildLibrariesIoProjectsUrl(
  owner: string,
  name: string,
  apiKey: string,
  perPage: number,
): string {
  return (
    `https://libraries.io/api/github/${encodeURIComponent(owner)}/` +
    `${encodeURIComponent(name)}/projects?api_key=${encodeURIComponent(apiKey)}&per_page=${String(perPage)}&page={page}`
  );
}
