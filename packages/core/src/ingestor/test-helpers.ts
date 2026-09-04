/**
 * Shared test helpers for ecosystem ingestor test suites
 *
 * Eliminates duplication across npm.test.ts, pypi.test.ts, go.test.ts.
 */

import { vi } from "vitest";

export const BASE = "https://raw.githubusercontent.com/owner/repo/main";

/** Build a minimal fetch mock that returns different responses per URL */
export function mockFetch(
  responses: Record<string, { status: number; body?: string }>,
): (input: string | URL, init?: RequestInit) => Response {
  return vi.fn((input: string | URL, init?: RequestInit): Response => {
    const url = input.toString();
    const match = responses[url];

    if (!match) {
      return new Response(null, { status: 404 });
    }

    // HEAD requests have no body
    if (init?.method === "HEAD") {
      return new Response(null, { status: match.status });
    }

    return new Response(match.body ?? "", { status: match.status });
  });
}

export function lockUrl(name: string, base = BASE): string {
  return `${base}/${name}`;
}
