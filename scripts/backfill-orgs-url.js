/**
 * Pure helper for the scripts/backfill-orgs.mjs env-var preference.
 *
 * Returns the unpooled connection string when set and non-empty, falls
 * back to the pooled one, returns null when neither is set. Split out of
 * backfill-orgs.mjs (which is a top-level-await script with module-level
 * side effects, awkward to unit-test in isolation) so the env-var
 * preference has a single, directly-testable source of truth.
 *
 * The order is load-bearing. Per AGENTS.md §5 / ADR 0023:
 *   - `DATABASE_URL` is the pooled PgBouncer endpoint.
 *   - `DATABASE_URL_UNPOOLED` is the direct endpoint, required for the
 *     DDL-style writes this project's backfill scripts do (org upserts
 *     + repos.orgId updates hit enum-typed columns that have hit
 *     PgBouncer's prepared-statement quirks historically).
 *
 * The 2026-08-30 backfill (reports/perf/2026-08-30/round-5-fixed/backfill-log.md)
 * shipped reading only `DATABASE_URL` and silently no-op'd against the
 * pooled endpoint, finding 0 repos with NULL `org_id` against the unpooled
 * reality. resolveDatabaseUrl() and its test are the durable fix.
 *
 * Returns `null` for the "neither set" case rather than throwing — the
 * script's caller turns that into a process.exit(1) with a precise
 * message. Treating the missing-env case as a typed null is easier to
 * unit-test than catching a throw.
 */
export function resolveDatabaseUrl(env) {
  const unpooled = env["DATABASE_URL_UNPOOLED"];
  if (typeof unpooled === "string" && unpooled !== "") {
    return unpooled;
  }
  const pooled = env["DATABASE_URL"];
  if (typeof pooled === "string" && pooled !== "") {
    return pooled;
  }
  return null;
}
