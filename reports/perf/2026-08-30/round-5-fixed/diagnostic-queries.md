# Diagnostic queries — Phase 1.2

**Date:** 2026-08-30
**Tool:** ego-browser against the Neon console SQL editor for the production branch.
**Branch:** `br-square-hill-aovhsm68` (production) within project `small-fog-28210807` (deptend.dev) in the Athena Studio org.
**Database:** `neondb`.

## Diagnosis: Branch A confirmed

The `organizations` table is empty in production, and `repos.org_id` is `NULL` for all 4 known repos. The fix is the one-time backfill at `scripts/backfill-orgs.mjs`. No code change to the writer is needed; the data simply has not been backfilled.

## Q1 — `organizations` table

```sql
SELECT id, github_login, name, avatar_url, created_at
FROM organizations
ORDER BY created_at DESC NULLS LAST;
```

**Result:** 0 rows. The query returned "No result" and "Statement executed successfully" in 112 ms.

## Q2 — `repos` table (org_id, ingestion_status)

```sql
SELECT id, owner, name, org_id, ingestion_status, created_at
FROM repos
ORDER BY created_at DESC NULLS LAST;
```

**Result:** 4 rows, 71 ms. The `org_id` column is empty (NULL) for every row.

| # | id | owner | name | org_id | ingestion_status | created_at |
|---|---|---|---|---|---|---|
| 1 | bf59d640-4d2e-48f3-a1ff-82daeedcbd28 | psf | requests | (null) | complete | 2026-08-22 13:30:04.098808+00 |
| 2 | 95d4c12b-2c66-4b90-a15f-fa67bd7f4292 | SpIob | deptend-go-test-fixture | (null) | complete | 2026-07-27 00:02:51.361225+00 |
| 3 | 5dd9ef96-6ac0-4cc8-acc7-4ac7d439ebc1 | SpIob | FlowState | (null) | complete | 2026-07-22 09:52:41.182646+00 |
| 4 | 094d4f66-42e4-4102-8a39-cf760476f249 | SpIob | Bagong-Enerhiya | (null) | skipped | 2026-07-21 04:28:46.462934+00 |

## Q3 — distinct owner logins (sanity check)

```sql
SELECT DISTINCT owner FROM repos ORDER BY owner;
```

**Result:** 2 rows, 49 ms.

| # | owner |
|---|---|
| 1 | SpIob |
| 2 | psf |

Two unique owner logins across 4 repos. The backfill will fetch metadata for these 2 logins (one GitHub API call per login, fall-through to `/users/{login}` if `/orgs/{login}` 404s).

## Branches ruled out

- **Branch B (writer bug — `org_id` set but `organizations` empty):** ruled out — `org_id` is NULL for all 4 rows, so the writer never tried to set it. The writer's `input.org` was simply not passed in any of these ingestion runs, because the runs happened before the `lookupGitHubOwnerMeta` plumbing shipped (ADR 0047).
- **Branch C (data normalization — login mismatch):** ruled out — `repos.owner` stores "SpIob" and "psf" exactly as the GitHub login; the backfill will use `repo.owner` directly via `lookupGitHubOwnerMeta(owner, ...)` per `backfill-orgs.mjs:84`.
- **Branch D (read path bug):** ruled out — the read path returns `null` because the data is `null`; no read-path fix is needed.

## Conclusion

The fix is `node scripts/backfill-orgs.mjs` against production, with `GITHUB_TOKEN` set if available (5 000 req/hr vs 60). For 2 orgs, the script finishes in seconds either way.
