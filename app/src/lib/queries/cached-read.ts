/**
 * Shared `unstable_cache` wrapper for /app's read-side queries (ADR 0033).
 *
 * The shape: one TTL, one revival pass, one tag union. Keeping all three
 * in a single module means there is one place to look for the
 * cache-invalidation convention, and one place to update when a new read
 * needs a new tag. Before this module existed, both queries/missions.ts
 * and queries/organizations.ts reimplemented `cachedRead` locally with
 * slightly different tag unions — a new read added to either file had to
 * be carefully wired into the right tag (or it silently went under the
 * other workspace's invalidation umbrella). One definition, one truth.
 *
 * Cache-tag invalidation matrix
 * -----------------------------
 * "missions" — the board and per-repo mission lists. Invalidated by:
 *   - POST /api/missions/[id]/claim       (revalidateTag "missions", "repos")
 *   - POST /api/missions/[id]/unclaim     (revalidateTag "missions", "repos")
 *   - POST /api/missions/[id]/dismiss     (revalidateTag "missions", "repos")
 *   - POST /api/missions/[id]/undismiss   (revalidateTag "missions", "repos")
 *   - POST /api/repos/[id]/withdraw       (revalidateTag "repos", "missions")
 *
 * "repos" — repo directory rows + their derived counts. Invalidated by:
 *   - POST /api/repos                     (revalidateTag "repos")
 *   - POST /api/repos/[id]/withdraw       (revalidateTag "repos", "missions")
 *   - POST /api/repos/[id]/notifications/subscribe   (revalidateTag "repos")
 *   - POST /api/repos/[id]/notifications/unsubscribe (revalidateTag "repos")
 *
 * "organizations" — org detail + membership reads. (No mutating route
 * invalidates this tag today; org membership changes are not yet a user
 * surface, so the 60 s TTL is the only freshness mechanism.)
 *
 * Bookmark / unbookmark routes do NOT revalidate either tag. Per-user
 * data is overlaid on every read (uncached path) so the directory's
 * `isBookmarked` flag is always live without invalidating the global
 * view.
 *
 * Date revival: unstable_cache serializes through JSON, so on a cache hit
 * every Date comes back as an ISO string. reviveDates() runs on the
 * RESULT of cached() — outside unstable_cache — deliberately. Inside the
 * wrapped callback its output would be JSON-serialized into the store
 * before the caller ever saw it, so every served value (miss AND hit)
 * would arrive as "*At" ISO strings and Date-typed consumers would crash
 * (found live: repo-card's toLocaleDateString took down / in production
 * with exactly that placement — see ADR 0033's correction note). Outside,
 * the miss path gets live Dates from the driver and passes through
 * unchanged, and the hit path gets real Dates revived from their stored
 * ISO strings.
 */

import { unstable_cache } from "next/cache";

/** All cache tags in use across /app's read layer. */
export type ReadCacheTag = "missions" | "repos" | "organizations";

/** How stale ingestion-driven reads may get (ADR 0033 — chosen by Mico). */
export const READ_CACHE_SECONDS = 60;

/**
 * Matches exactly what a Postgres timestamptz column serializes to over
 * JSON — an ISO 8601 timestamp ("2026-08-23T12:34:56.789Z", offset form
 * included). The suffix check alone isn't enough: new Date("garbage")
 * silently yields Invalid Date, and jsonb blobs (rawData, scoring inputs)
 * can legally carry non-date "*At"-suffixed keys. A string that fails this
 * shape passes through untouched instead of being corrupted.
 */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Revives ISO-string timestamps stored under "*At" keys back into Date
 * instances. Recurses into nested objects and arrays (rawData, scoring
 * inputs, etc.). The miss path passes through live Date objects
 * unchanged.
 *
 * Exported for unit testing (same convention as osv.ts's pure utilities).
 */
export function reviveDates<T>(value: T): T {
  return reviveValue(value) as T;
}

/** Recursion core over `unknown` — typed-linting safe, no `any` leakage. */
function reviveValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => reviveValue(item));
  }
  const revived: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    revived[key] =
      typeof field === "string" && key.endsWith("At") && ISO_TIMESTAMP_RE.test(field)
        ? new Date(field)
        : reviveValue(field);
  }
  return revived;
}

/** unstable_cache wrapper for one cached read: fixed key parts + tag + TTL. */
export function cachedRead<T>(
  keyParts: string[],
  tag: ReadCacheTag,
  read: () => Promise<T>,
): Promise<T> {
  const cached = unstable_cache(read, keyParts, {
    revalidate: READ_CACHE_SECONDS,
    tags: [tag],
  });
  return cached().then(reviveDates);
}
