/**
 * Regression test for the 2026-08-30 backfill-orgs env-var bug.
 *
 * Backfill run 1 against the deployed site used `node scripts/backfill-orgs.mjs`
 * (no env override) and silently processed zero repos — `isNull(repos.orgId)`
 * returned 0 rows against the pooled PgBouncer endpoint, even though the
 * same query against `DATABASE_URL_UNPOOLED` on the same branch returned
 * 4 rows. Run 2, with `DATABASE_URL="$DATABASE_URL_UNPOOLED"`, backfilled
 * 4/4. The original code read only `process.env.DATABASE_URL`; the fix
 * prefers `DATABASE_URL_UNPOOLED` when set. See
 * reports/perf/2026-08-30/round-5-fixed/backfill-log.md.
 *
 * resolveDatabaseUrl() is the load-bearing piece: it lives in
 * backfill-orgs-url.js so this test can hit it directly without mocking
 * the neon / drizzle layer around the script's top-level await.
 *
 * Per AGENTS.md §6's mocks-vs-real-path meta-lesson, the durable proof
 * here is the live workflow_dispatch / workflow run + a successful
 * 4/4 (or N/N) backfill against the deployed site, not these unit
 * tests; these are the regression net.
 */

import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "./backfill-orgs-url.js";

describe("resolveDatabaseUrl", () => {
  it("prefers DATABASE_URL_UNPOOLED when set", () => {
    expect(
      resolveDatabaseUrl({
        DATABASE_URL: "pooled",
        DATABASE_URL_UNPOOLED: "unpooled",
      }),
    ).toBe("unpooled");
  });

  it("prefers DATABASE_URL_UNPOOLED when set even to a falsy-looking string", () => {
    // Whitespace-only and other non-empty strings are still treated as
    // "set" — the script will fail later with a clear error if the URL
    // is bad, which is better than silently picking the wrong one.
    expect(
      resolveDatabaseUrl({
        DATABASE_URL: "pooled",
        DATABASE_URL_UNPOOLED: "  ",
      }),
    ).toBe("  ");
  });

  it("falls back to DATABASE_URL when DATABASE_URL_UNPOOLED is unset", () => {
    expect(
      resolveDatabaseUrl({
        DATABASE_URL: "pooled",
      }),
    ).toBe("pooled");
  });

  it("falls back to DATABASE_URL when DATABASE_URL_UNPOOLED is empty string", () => {
    expect(
      resolveDatabaseUrl({
        DATABASE_URL: "pooled",
        DATABASE_URL_UNPOOLED: "",
      }),
    ).toBe("pooled");
  });

  it("returns null when neither is set", () => {
    expect(resolveDatabaseUrl({})).toBeNull();
  });

  it("returns null when both are explicitly empty", () => {
    expect(
      resolveDatabaseUrl({
        DATABASE_URL: "",
        DATABASE_URL_UNPOOLED: "",
      }),
    ).toBeNull();
  });

  it("regression: matches the documented `.env.local` shape on a dev machine", () => {
    // The exact shape a developer's .env.local has, copy-pasted from a
    // real env: both vars present, UNPOOLED is the direct endpoint,
    // DATABASE_URL is the pooled PgBouncer endpoint. This is the
    // scenario the 2026-08-30 backfill silently no-op'd against before
    // the fix.
    const unpooled =
      "postgresql://neondb_owner:secret@ep-direct-12345.c-2.region.aws.neon.tech/neondb?sslmode=require";
    const pooled =
      "postgresql://neondb_owner:secret@ep-direct-12345-pooler.c-2.region.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
    expect(
      resolveDatabaseUrl({
        DATABASE_URL: pooled,
        DATABASE_URL_UNPOOLED: unpooled,
      }),
    ).toBe(unpooled);
  });
});
