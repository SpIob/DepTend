# ADR 0047; Populate the `organizations` table from the ingestion pipeline

**Status:** Accepted
**Date:** 2026-08-29

---

## Context

The per-org directory route (`app/src/app/org/[org]/page.tsx`) was built and shipped, but in production it has always served a permanent loading skeleton: the `getOrganizationByLogin(orgLogin)` query at `app/src/lib/queries/organizations.ts:18-28` always returns `null` because the `organizations` table has been empty in production from day one. Every SpIob repo in the system is associated with the SpIob GitHub org, but `repos.org_id` is `NULL` for all rows.

The root cause: the ingestion pipeline (per AGENTS.md §2) was deliberately scoped to dependency data — `dependencies`, `advisories`, `missions`. GitHub-side org metadata (login, name, avatar) was never fetched. The `organizations` table and `repos.org_id` column have existed in the schema since ADR 0027 (per the migration `0004_yellow_firestar.sql`), but no code path populated them.

A UI audit on 2026-08-29 surfaced this as Finding #2. The org page returns 200, but its body is the parent `loading.tsx` skeleton indefinitely (14 `animate-pulse` divs, no `<h1>`, no repo links) on both local dev and `deptend.vercel.app`. The page title (`Organization: SpIob — DepTend`) renders because `generateMetadata` runs first, but the page render itself falls through.

The same audit also surfaced Finding #1 — the per-repo page truncating mission lists at 50 (BOARD_PAGE_SIZE) — which is a separate data-loss bug, fixed separately in this same change but not in scope for this ADR.

## Decision

Make the ingestion pipeline fetch the GitHub-side owner profile for every ingested repo, in parallel with the existing `fetchGitHubRepoMeta` call, and pass it to the writer. The writer upserts the row into `organizations` and sets `repos.org_id` for the just-upserted repo.

A one-time backfill script (`scripts/backfill-orgs.mjs`) walks every existing repo with `org_id IS NULL` and populates them by reusing the same fetch + upsert code path.

The org page is **not** changed. Once the schema is populated, the existing query (`packages/core/src/db/queries.ts:729-831` `getRepoDirectoryBase`) returns the right rows, and the existing page renders them as-is.

## Implementation

### New module: `packages/core/src/ingestor/github-org-meta.ts`

- `lookupGitHubOwnerMeta(login, token, options?)` — `GET /orgs/{login}` first; on 404, falls back to `GET /users/{login}` (personal accounts return 404 on the org endpoint). Returns a uniform `GitHubOwnerMeta { login, name, avatarUrl, isOrg }`.
- Throws `GitHubOrgMetaError(kind: "not_found" | "rate_limited")` for the two branch-worthy failures; lets `fetchJson` (the same shared helper `fetchGitHubRepoMeta` uses) throw the default Error for network failures and 5xx.
- One `/orgs` call, one `/users` call only on 404 fall-through. Free-tier-safe: 5,000 req/hr authenticated (`GITHUB_TOKEN`); 60 req/hr unauthenticated. At a typical ingestion cadence (a few repos per cron run) the rate budget is unaffected.

### Writer change: `packages/core/src/ingestor/writer.ts`

`WriteIngestionInput` gains an optional `org?: { githubLogin, name, avatarUrl }` field. When present, the writer's `write()` method runs an extra step between the repo upsert and the transactional write block:

```ts
// 1. Upsert repo
const repoId = await this.upsertRepo(input.repo);

// 1b. If the caller supplied GitHub-side owner metadata, upsert the org
// row and link the repo to it.
let orgId: string | null = null;
if (input.org !== undefined) {
  const orgRow = await upsertOrganization(this.db, { … });
  orgId = orgRow.id;
  await this.db.update(repos).set({ orgId }).where(eq(repos.id, repoId));
}
```

The step is done BEFORE the transactional write block so a downstream failure of the advisory/dependency writes still leaves the org/repo association in place — the next cron run can re-attempt without the link silently regressing to `NULL`.

The step is OPTIONAL (`input.org?: ...` with a no-op default) so callers that haven't migrated yet — `manifest-check.ts`'s submission pre-check, the legacy test fixture — are unaffected.

### `upsertOrganization` type widening: `packages/core/src/db/organizations.ts`

The existing function took `db: ReadonlyDb` (the `/app` HTTP driver). The writer uses `NeonDatabase<any>` (the ingestor's WebSocket driver, needed for `db.transaction(...)`). Widened to a structural `DrizzleDb` type:

```ts
export type DrizzleDb = NeonHttpDatabase<typeof schema> | NeonDatabase<any>;
```

Both drivers expose the same `insert(...).onConflictDoUpdate().returning()` shape that `upsertOrganization` exercises, so a structural union is more honest than picking one driver and casting the other at every call site.

### `scripts/ingest.js` wiring

The `ingestRepo` function in the daily-cron script now fetches org metadata in parallel with the existing repo meta:

```js
const [ghMeta, orgResult] = await Promise.allSettled([
  fetchGitHubRepoMeta(owner, name, githubToken),
  lookupGitHubOwnerMeta(owner, githubToken),
]);
```

Both calls are public GitHub API, both need only the owner login, and both are independent. Running them in parallel cuts roughly half the per-repo GitHub wall time for the new call (the existing call is unchanged in cost). A `Promise.allSettled` (not `Promise.all`) is used so a failed org fetch doesn't take down the repo-meta fetch — `org` is treated as best-effort: `not_found` is fatal (the login is a deleted account or typo), `rate_limited` is fatal (the next cron run will hit the same wall), and any other error (network) is logged and the run proceeds without org metadata. The repo-meta failure remains fatal, unchanged.

### One-time backfill: `scripts/backfill-orgs.mjs`

Walks every existing `repos` row where `org_id IS NULL`, calls `lookupGitHubOwnerMeta(owner)`, and writes the result via the same `db.insert(organizations).values(...).onConflictDoUpdate(...)` chain. Idempotent: re-running picks up the same rows and the upsert collapses to no-op for orgs that already exist. Run once after this ADR ships; never needs to run again.

### Per-repo page data-loss bug, fixed in this same change

A separate Finding #1 from the same audit: the per-repo page calls `getRepoBoardPage(repo.id, filters)` without options, and the underlying query defaults `limit: BOARD_PAGE_SIZE` (50). Two of the eight indexed repos in the dev DB exceed that — `SpIob/deptend-go-test-fixture` (55 missions, 5 dropped) and `psf/requests` (51, 1 dropped). Same bug on `deptend.vercel.app`. The per-repo page sets `pageSize = board.missions.length` (the truncated 50) and `pageCount = 1`, so the range line never renders and the user has no signal that anything is missing.

Fixed in this same change by passing a non-default `limit: 1000` from `app/src/app/repo/[owner]/[name]/page.tsx:97` and threading an `options` parameter through `app/src/lib/queries/missions.ts` to the wrapped `coreGetRepoBoardPage`. The per-repo JSDoc on `getRepoBoardPage` was updated to note that the per-repo caller passes its own limit. ADR 0031's `/missions` pagination is unaffected.

## Consequences

**Positive.**

- The `/org/[org]` route now renders correctly for any org that has at least one indexed repo. Verified end-to-end against dev Neon: ran the backfill against the 9 NULL-`org_id` repos, then `curl http://localhost:3000/org/SpIob` returns 200 with the h1 "SpIob" and 8 `<article>` cards. The browser screenshot of `/org/SpIob` shows the full grid.
- The same fix unlocks a future "Repos by org" footer on each repo card (the data flow is now in place) without a separate code change.
- The `ingestRepo` per-repo wall time is roughly halved for the new fetch because the two GitHub calls run in parallel — total cost is `max(repo-meta, org-meta)` instead of `sum(repo-meta, org-meta)`.
- The backfill is idempotent: re-running after a partial failure is safe; the upsert collapses for orgs that already exist.

**Negative.**

- One additional HTTP call per ingestion run. At 5,000 req/hr authenticated (the production posture) this is well within budget. At 60 req/hr unauthenticated, the dev-only fallback, the daily cron caps at ~24 orgs/minute and the run-time grows by a few seconds for any modestly-sized batch — acceptable, but not free.
- `scripts/ingest.js` got the new `lookupGitHubOwnerMeta` call but did not get a new env-var for opting out. If the GitHub API is unreachable for an extended period, a deployment with `GITHUB_TOKEN` set will still burn through the rate budget on `lookupGitHubOwnerMeta` retries. (Retry policy is the same `fetch-retry.ts` one-retry-on-transient-failure that `fetchGitHubRepoMeta` already uses.) For now this is the right trade — the org data is needed for the per-org page, and a fallback to "no org metadata" still works because the per-org page is best-effort (anonymous viewers don't see the org column).

**Open question / future work.**

- `/org/[org]/page.tsx` has no "back to /" link in the header. The audit flagged it as a possible improvement; not in scope for this fix. Tracked in the same UI audit report.
- `isSubscribed` for orgs is not yet wired (the `notification_subscriptions` table has per-repo rows, not per-org). When the user/org split is needed, this same code path is the place to extend.
