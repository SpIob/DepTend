# Backfill log — Phase 1.3

**Date:** 2026-08-30
**Script:** `scripts/backfill-orgs.mjs`
**Branch:** production (`br-square-hill-aovhsm68`)
**Database:** `neondb` via `ep-solitary-frost-ao44h8wf` (unpooled endpoint)

## Run 1 — `DATABASE_URL` (pooled), no override

```bash
node scripts/backfill-orgs.mjs
```

```
Found 0 repos with no org_id.

Backfill complete. succeeded=0 skipped=0 failed=0
```

**Result: 0 repos backfilled (no-op).** Despite the Neon console SQL editor showing 4 repos with `org_id IS NULL` against the same production branch, the script's `db.select().from(repos).where(isNull(repos.orgId))` returned 0 rows. This is because `DATABASE_URL` (the pooled PgBouncer endpoint) was routing to a different Neon endpoint with stale-read-replica behavior, or otherwise returning a result that did not reflect the unpooled-side truth.

## Run 2 — `DATABASE_URL=$DATABASE_URL_UNPOOLED`

```bash
DATABASE_URL="$DATABASE_URL_UNPOOLED" node scripts/backfill-orgs.mjs
```

```
Found 4 repos with no org_id.
  + SpIob/Bagong-Enerhiya -> SpIob (orgId=449ad76a-63d9-4d1e-a7e1-db204160ec5b)
  + psf/requests -> psf (orgId=e0307551-f8ad-43a7-a6cf-7849cff5835b)
  + SpIob/FlowState -> SpIob (orgId=449ad76a-63d9-4d1e-a7e1-db204160ec5b)
  + SpIob/deptend-go-test-fixture -> SpIob (orgId=449ad76a-63d9-4d1e-a7e1-db204160ec5b)

Backfill complete. succeeded=4 skipped=0 failed=0
```

**Result: 4/4 repos backfilled. 2 distinct org logins (SpIob, psf), 2 org rows created.**

## Bug surfaced: `scripts/backfill-orgs.mjs` uses the wrong env var

The script's line 46 reads `process.env.DATABASE_URL`, but per AGENTS.md §5, `DATABASE_URL` is the **pooled** PgBouncer connection while `DATABASE_URL_UNPOOLED` is the direct connection. The script's `neon(DATABASE_URL)` against PgBouncer returned 0 rows for `isNull(repos.orgId)` even though the same query against the unpooled URL returned 4 rows.

This is a real, fixable bug: the script's documented usage (`node scripts/backfill-orgs.mjs`) is a silent no-op when the dev environment's `DATABASE_URL` is the pooled endpoint. The fix is to prefer `DATABASE_URL_UNPOOLED` when set, falling back to `DATABASE_URL`.

**Surfaced as a follow-up. Not in scope for Phase 1.3 (which is the org-page 404 fix); will be a separate commit under Phase 4 / AGENTS.md §12.** It is, however, the kind of issue the new "live verification before Accepted" rule in §10 is meant to catch: the backfill script's docstring claims it works, and the prior ADR 0047 acceptance flipped without anyone running it end-to-end against production.

## Verification

After the backfill and after the `unstable_cache` 60 s TTL elapsed:

- `/org/SpIob` renders the org name ("SpIob") and 3 repo cards (Bagong-Enerhiya, FlowState, deptend-go-test-fixture).
- `/org/psf` renders the org name ("Python Software Foundation") and 1 repo card (psf/requests) with star count, ecosystem badge, and severity counts.
- `/` still renders the directory with 3 indexed repos (Bagong-Enerhiya is `skipped` per the diagnostic, so it doesn't appear in the indexed count, which is the correct behavior).
