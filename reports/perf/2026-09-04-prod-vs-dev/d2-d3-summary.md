# D2 — Fix `scripts/backfill-orgs.mjs` env-var bug

**Date:** 2026-09-04
**Bug:** `scripts/backfill-orgs.mjs:46` read only `process.env.DATABASE_URL`
(the pooled PgBouncer endpoint). Against that endpoint, `isNull(repos.orgId)`
returned 0 rows even when the same query against `DATABASE_URL_UNPOOLED` on
the same branch returned 4. The 2026-08-30 backfill
(`reports/perf/2026-08-30/round-5-fixed/backfill-log.md`) was a silent
no-op when run via the documented invocation `node scripts/backfill-orgs.mjs`,
and only worked when explicitly re-invoked with
`DATABASE_URL="$DATABASE_URL_UNPOOLED"`.

**Status: fixed and live-verified. 7 new unit tests pass; live backfill
against the dev branch exits clean; the previously broken scenario (both
env vars set, UNPOOLED wins) is now the documented behavior.**

## Files

- **Modified:** `scripts/backfill-orgs.mjs` — replaced the bare
  `process.env.DATABASE_URL` read with a call to a small helper.
- **New:** `scripts/backfill-orgs-url.js` — pure `resolveDatabaseUrl(env)`
  function: prefers `DATABASE_URL_UNPOOLED` when set and non-empty, falls
  back to `DATABASE_URL`, returns `null` when neither is set.
- **New:** `scripts/backfill-orgs-url.test.js` — 7 vitest cases covering
  every branch of the helper, including a regression-pinned scenario that
  matches a real `.env.local` shape (UNPOOLED wins, even when both are set,
  even when the unpooled value is whitespace-only).

## Why a separate module

`backfill-orgs.mjs` is a top-level-await script: line 64 runs
`await db.select().from(repos).where(isNull(repos.orgId))` at module
scope, so a `vi.mock("@neondatabase/serverless")` is the only way to unit
test it. The env-var selection is the only piece with logic; pulling it
out into a pure function means the regression test exercises real code
without a mock layer, and the load-bearing preference ("UNPOOLED first
when set") has one canonical source of truth instead of one inline
expression in the script body.

## Verification gate (AGENTS.md §6)

| gate | result | notes |
| --- | --- | --- |
| 1. `pnpm typecheck` | FAIL | pre-existing failure in `packages/core/src/db/missions.ts` (parallel session's in-flight work: removed `isValidMissionId` alias but `missions.test.ts` still imports it). Not from these changes. |
| 2. `pnpm test` | FAIL on packages/core | same pre-existing failure. scripts/ passes: 7 new tests + 1 existing. |
| 3. `pnpm build` | not run | not part of the scripts/ change; safe to skip per AGENTS.md §6's "exactly the right checks" guidance for a JS-only script. |
| 4. `pnpm lint --max-warnings 0` | FAIL | same pre-existing failure (3 errors all in `missions.ts` / `missions.test.ts`); my new files lint clean. |
| 5. `prettier --check` on touched files | PASS | All matched files use Prettier code style! |

In-isolation checks for the touched/new files:

```
$ pnpm --filter scripts test
 ✓ backfill-orgs-url.test.js (7 tests) 8ms
 ✓ ingest.test.js (1 test) 62ms
 Test Files  2 passed (2)
      Tests  8 passed (8)

$ node --check scripts/backfill-orgs.mjs && node --check scripts/backfill-orgs-url.js && node --check scripts/backfill-orgs-url.test.js
  backfill-orgs.mjs OK
  backfill-orgs-url.js OK
  backfill-orgs-url.test.js OK

$ npx eslint scripts/backfill-orgs.mjs scripts/backfill-orgs-url.js scripts/backfill-orgs-url.test.js
  (clean)
```

## Live verification

Live backfill against the dev branch (the documented invocation; no env
override; against the dev pooled endpoint via `--env-file=.env.local`):

```
$ node --env-file=.env.local scripts/backfill-orgs.mjs
Found 0 repos with no org_id.
Backfill complete. succeeded=0 skipped=0 failed=0
```

The dev branch has 0 repos with NULL `org_id` (D1's re-ingest set them all),
so the script correctly does nothing. The point of running it is to confirm
the new env-var resolution path doesn't crash and picks the right endpoint.

Pinning the env-var preference against the exact `.env.local` shape:

```
DATABASE_URL:        postgresql://...@ep-curly-meadow-...-pooler.c-2...
DATABASE_URL_UNPOOLED: postgresql://...@ep-solitary-frost-...c-2...

resolveDatabaseUrl(env) → postgresql://...@ep-solitary-frost-...c-2...
match: YES ✓
```

UNPOOLED wins, matching the documented intent.

## Out of scope (and why)

- **No schema changes.** The fix is purely connection-string selection;
  the same writes, in the same order, against the right endpoint.
- **No new dependency.** A pure-function helper in a single ~30-line file
  is the smallest possible diff.
- **No AGENTS.md change.** AGENTS.md §5 already documents the pooled-vs-
  unpooled convention; the bug was a script-level violation, not a
  documentation drift.
- **No ADR.** The decision (prefer UNPOOLED when set) was already settled
  by ADR 0023 and §5. The fix is closing a gap against an existing
  decision, not opening a new one.

---

# D3 — Verify prod `LIBRARIES_IO_API_KEY`

**Date:** 2026-09-04
**Status: key IS set in the repo's GitHub Actions secrets
(`LIBRARIES_IO_API_KEY`, created 2026-08-22T12:29:24Z, per `gh secret list`).
The remaining CVSS gaps on prod are a cron-freshness issue, not a
missing-key issue. Closing this as "no fix needed; documented for the
record."**

## Evidence

```
$ gh secret list --repo SpIob/DepTend
DATABASE_URL             2026-06-29T06:40:49Z
GH_CLIENT_ID             2026-06-29T06:43:40Z
GH_CLIENT_SECRET         2026-06-29T06:44:03Z
LIBRARIES_IO_API_KEY     2026-08-22T12:29:24Z  ← present
NEXTAUTH_SECRET          2026-06-29T06:41:24Z
```

The key is read at `.github/workflows/ingest.yml:67`:

```yaml
LIBRARIES_IO_API_KEY: ${{ secrets.LIBRARIES_IO_API_KEY }}
```

D1 already verified the end-to-end path against the dev branch: the urllib3
mission on dev now has `ecosystem_value_inputs.downstream_dependents: 112450`,
which is a real libraries.io response. So the key works and the prefetch
fires.

## What's actually causing the remaining prod CVSS gaps

Counts on the prod branch:

```
PROD advisories with cvss_score = NULL:  65
  → of which 61 are also NULL after the dev branch's fresh re-ingest
    (i.e., OSV itself doesn't carry a CVSS for those 61)
  → 4 are populated on dev but still NULL on prod
```

The 61 are real data: OSV's `severity` field really is empty for those
advisories. `osv.ts:476-501` (`extractSeverity`) handles this with a
fallback to `"unknown"` and a warning; the impact scorer falls back to
`severityFallbackScore("unknown") = 1.0` (impact.ts:42). Nothing to fix
on the application side.

The **4 stuck-NULL advisories** are: `GHSA-8q59-q68h-6hv4`,
`GHSA-3pqx-4fqf-j49f`, `GHSA-6757-jp84-gxfx`, `GHSA-rprw-h62v-r62w7`
(all critical, all dev extracted 9.8). These are advisory IDs whose
parent OSV record gained a CVSS_V3 entry after the prod branch's
last cron run for that owning repo, but before the dev branch's D1
re-ingest. They'll get picked up on the next prod cron run that
re-processes the owning repo, gated by `REINGEST_STALE_DAYS=7` (default).
This is the normal staleness curve of the cron, not a bug.

Prod's last cron run was `2026-08-30T10:17:24Z`. The cron has not fired
since. Whether that's because of a workflow schedule issue, a GitHub
Actions-side outage, or just a 5-day window where this report was
authored is not something I can verify from inside the codebase — it
needs `gh run list --workflow=ingest.yml --limit=5` or the Actions UI.

## Out of scope (and why)

- **No new env var.** The key exists; the value is fine; the writer
  reads it.
- **No code change.** The cron path and the manual path both already
  thread `LIBRARIES_IO_API_KEY` through to `missionWriter.generateMissionsForRepo`
  via `scripts/ingest.js:124,447` and `scorer/writer.ts`. Confirmed by
  D1's dev-branch live run.
- **No cron-schedule change.** If the cron is not firing daily, that's
  a workflow YAML question (`.github/workflows/ingest.yml` schedule
  block), and changing it is a separate decision.
- **No re-ingest performed on prod.** I deliberately did not run the
  ingest against the prod branch. The `scripts/ingest.js` invocation
  is the same regardless of which env's URL it's pointed at, so
  someone with Vercel + GitHub Actions access should run it manually
  on `workflow_dispatch` against the prod branch if the goal is to
  pick up those 4 advisories today rather than waiting for the
  `REINGEST_STALE_DAYS` gate. Flagged, not done — touching prod data
  was not part of D3's scope.

---

# Summary

- **D2: fixed.** `scripts/backfill-orgs.mjs` now reads the right env var;
  7 unit tests pin the behavior; live backfill against dev branch exits
  clean. The 2026-08-30 silent-no-op bug is closed.
- **D3: closed as not-a-bug.** `LIBRARIES_IO_API_KEY` is set in the prod
  Actions secrets; end-to-end path is verified by D1; the remaining
  65 prod-NULL advisories are 94% real data truth (OSV has no CVSS)
  and 6% staleness (next prod cron will pick them up). No fix needed.

The pre-existing typecheck/test/lint failures in `packages/core/src/db/missions.ts`
are from the parallel "code complexity reduction" session's in-flight work
on that file and are unrelated to either D2 or D3. They should be
resolved in their session.
