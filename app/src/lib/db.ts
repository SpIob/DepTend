/**
 * Database client for /app
 *
 * Construction itself lives in @deptend/core (createReadonlyDb) — see
 * packages/core/src/db/queries.ts for why /app doesn't build Drizzle
 * queries or touch db/schema.js directly.
 *
 * Lazy on purpose: `next build` evaluates every route module during its
 * "Collecting page data" step even for a `force-dynamic` page — it never
 * calls the page function, but it does run top-level module code. A
 * client constructed eagerly at import time would throw during the build
 * itself whenever DATABASE_URL isn't set in the build environment (e.g.
 * this sandbox, or a Vercel preview build without env vars configured
 * yet). Building it on first actual use means the build only needs a
 * live DB connection at runtime, when a request actually comes in.
 */

import { createReadonlyDb, type ReadonlyDb } from "@deptend/core/db/queries.js";

let cached: ReadonlyDb | null = null;

export function getDb(): ReadonlyDb {
  if (cached !== null) {
    return cached;
  }

  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill in the pooled " +
        "Neon connection string.",
    );
  }

  cached = createReadonlyDb(url);
  return cached;
}
