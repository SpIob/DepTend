# ADR 0046; Consolidate `getIndexedRepoCount` + `getTotalRepoCount` + `getSkippedRepos` into one cached read

**Status:** Accepted
**Date:** 2026-08-29

---

## Context

The home page (`app/src/app/page.tsx:63-67`) and the board page (`app/src/app/missions/page.tsx:75-79`) each run three independent reads against the `repos` table as part of rendering the page header:

```ts
// / (home page, pre-0046)
const [repos, totalRepoCount, skippedRepos] = await Promise.all([
  getReposWithMissionSummary(login),
  getTotalRepoCount(),
  getSkippedRepos(),
]);

// /missions (board page, pre-0046)
const [board, repoCount, skippedRepos] = await Promise.all([
  getBoardMissionsPage(filters, query.page),
  getIndexedRepoCount(),
  getSkippedRepos(),
]);
```

Three reads, three independent `cachedRead` slots, three independent `unstable_cache` keys (`["indexed-repo-count"]`, `["total-repo-count"]`, `["skipped-repos"]`), each with its own `getDb()` invocation. All three are cached under the same `"repos"` tag with the same 60 s TTL (ADR 0033), so they all invalidate together — but they're three independent storage slots, three independent `revalidateTag` triggers (one of which can miss), and three HTTP round-trips on a cache miss.

The reads are tightly related:

- `getIndexedRepoCount` is `count(*) filter (where ingestion_status = 'complete')`.
- `getTotalRepoCount` is `count(*)` over the same table.
- `getSkippedRepos` is `select owner, name, ingestion_error from repos where ingestion_status = 'skipped'`.

Both count queries project scalars from the same full scan; the skipped-repos query is a separate (also index-supported, via `idx_repos_ingestion_status`) scan. Two of the three can be collapsed into a single `SELECT count(*) filter (...) as indexed_count, count(*)::int as total_count FROM repos`; the third (`getSkippedRepos`) is structurally different — it returns rows, not scalars — and stays a separate statement inside the same `Promise.all`.

At the 150-repo cap each individual statement is sub-millisecond; the real cost is the HTTP round-trip pair on a cache miss (3 round-trips per page render, every 60 s).

## Decision 1; One cached read, two statements inside

A new function `getRepoDirectorySummary(db)` in `packages/core/src/db/queries.ts` returns the full `{ indexedCount, totalCount, skippedRepos }` shape from a single `cachedRead` call. The cached callback runs `Promise.all([countQuery, getSkippedRepos(db)])`, so on a miss the underlying cost is **two round-trips**, not three.

```ts
export interface RepoDirectorySummary {
  indexedCount: number;
  totalCount: number;
  skippedRepos: SkippedRepo[];
}

export async function getRepoDirectorySummary(db: ReadonlyDb): Promise<RepoDirectorySummary> {
  const [counts, skippedRepos] = await Promise.all([
    db
      .select({
        indexedCount: sql<number>`count(*) filter (where ${repos.ingestionStatus} = 'complete')::int`,
        totalCount: sql<number>`count(*)::int`,
      })
      .from(repos),
    getSkippedRepos(db),
  ]);
  return {
    indexedCount: counts[0]?.indexedCount ?? 0,
    totalCount: counts[0]?.totalCount ?? 0,
    skippedRepos,
  };
}
```

The count statement projects both scalars in a single `SELECT`. The skipped-repos query is unchanged. Both ride the existing `idx_repos_ingestion_status` index.

## Decision 2; Re-export the three legacy functions as derived accessors

`app/src/lib/queries/missions.ts` keeps the three existing exports (`getIndexedRepoCount`, `getTotalRepoCount`, `getSkippedRepos`) as thin accessors that read from the new `getRepoDirectorySummary` cached read:

```ts
export function getIndexedRepoCount(): Promise<number> {
  return getRepoDirectorySummary().then((s) => s.indexedCount);
}
export function getTotalRepoCount(): Promise<number> {
  return getRepoDirectorySummary().then((s) => s.totalCount);
}
export function getSkippedRepos(): Promise<SkippedRepo[]> {
  return getRepoDirectorySummary().then((s) => s.skippedRepos);
}
```

This is a back-compat measure for any future caller that only needs one slice. **Crucially**, because all three accessors go through the same `cachedRead(["repo-directory-summary"], "repos", …)`, only the first accessor to run on a 60 s window hits the DB; the other two read from the cache.

## Decision 3; Update both page call sites to use the new shape directly

The home page and the board page switch to destructuring the summary:

```ts
// / (home page, post-0046)
const [repos, { totalRepoCount, skippedRepos }] = await Promise.all([
  getReposWithMissionSummary(login),
  getRepoDirectorySummary(),
]);

// /missions (board page, post-0046)
const [board, { indexedRepoCount, skippedRepos }] = await Promise.all([
  getBoardMissionsPage(filters, query.page),
  getRepoDirectorySummary(),
]);
```

Two `Promise.all` arrays instead of three, one round-trip pair instead of two, one cache slot instead of three. The legacy derived accessors stay in case a future caller wants the narrower surface.

## Decision 4; Cache invalidation matrix is unchanged

The new `getRepoDirectorySummary` uses tag `"repos"` and TTL 60 s — the same matrix cached-read.ts:14-31 documents for the existing `"repos"` tag. The mutating routes that already `revalidateTag("repos")` — `POST /api/repos`, `POST /api/repos/[id]/withdraw`, `POST /api/repos/[id]/notifications/subscribe`, `POST /api/repos/[id]/notifications/unsubscribe` — keep invalidating the new slot without any code change. The pre-0046 `["indexed-repo-count"]`, `["total-repo-count"]`, `["skipped-repos"]` keys are removed; the new `["repo-directory-summary"]` key takes their place.

## Decision 5; Verification: live against the dev Neon database, not just mocked round-trips

Per AGENTS.md §6's meta-lesson, the §6 gate alone is not enough for this change. Two specific risks the mock would not catch:

- **`count(*) filter (where …)` on a Postgres 18 enum column** — `repos.ingestion_status` is the `ingestion_status` enum (a Postgres-native enum, not a `text` column with a CHECK). A `count(*) filter (where ingestion_status = 'complete'::ingestion_status)` is the canonical form; the bare `'complete'` literal Drizzle emits may or may not need the cast in 18. The fake-transport test in `queries.test.ts` doesn't actually execute the SQL — it just asserts the SQL _text_ Drizzle generates. A type error would only surface live.
- **The two statements in `Promise.all` actually fire in parallel**, not serially. Vercel's neon-http driver is stateless and single-statement-per-request; the parallelism happens on the call site. A real round-trip pair is the only way to confirm both queries reach Postgres in the same wall-clock window.

**Before flipping to Accepted:**

1. `pnpm --filter @deptend/core build && pnpm typecheck` (full §6 gate).
2. Live `psql` against dev: `EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) filter (where ingestion_status = 'complete')::int, count(*)::int FROM repos;` — confirm `idx_repos_ingestion_status` is used (or the planner picks a Seq Scan on the small table; either is fine, both are sub-ms).
3. Visit `/` and `/missions` on dev; confirm the header chrome renders without a 500 or a `null` value.

The new `queries.test.ts` `getRepoDirectorySummary` block (mirroring the existing `getSkippedRepos` / `getIndexedRepoCount` test style) pins the SQL text, the result shape, and the Promise.all-pair dispatch. Live verification is the per-row contract that the mocks can't enforce.

## What changed

- `packages/core/src/db/queries.ts`; new `getRepoDirectorySummary(db)` function + `RepoDirectorySummary` type. The three legacy functions (`getIndexedRepoCount`, `getTotalRepoCount`, `getSkippedRepos`) are unchanged.
- `packages/core/src/db/queries.test.ts`; new `describe("getRepoDirectorySummary")` block (3 tests) covering the combined shape, the round-trip-pair dispatch, and the empty-row case. The existing per-function tests stay.
- `app/src/lib/queries/missions.ts`; new `getRepoDirectorySummary` cached-read wrapper. The three legacy wrappers now derive from it. Unused `coreGetIndexedRepoCount` / `coreGetTotalRepoCount` / `coreGetSkippedRepos` re-imports removed.
- `app/src/lib/queries/missions.test.ts`; new `describe("getRepoDirectorySummary cached read (ADR 0046)")` block (3 tests) covering the single cache slot, the cache key/tag/TTL shape, and the derived-accessor equivalence. The existing `cachedRead revival placement` and `repo-directory-base` tests stay.
- `app/src/app/page.tsx`; call site switched to `getRepoDirectorySummary()`, destructured.
- `app/src/app/missions/page.tsx`; call site switched to `getRepoDirectorySummary()`, destructured.
- `CHANGELOG.md`; entry under `[Unreleased]`.

**No schema migration. No `scripts/ingest.js` change. No mutating-route change.** Every page render reads the same data, with one fewer round-trip pair on a cache miss and one fewer cache slot in the data store.

## Consequences

- **One round-trip pair per 60 s per worker per page render**, on a cache miss. (The cached path is one in-memory read; the round-trip savings only apply on a miss.) Pages that were previously the cold-start critical path (`/`, `/missions`) drop from 3 round-trips to 2 in the worst case and from 1 round-trip to 1 in the warm case.
- **One cache slot instead of three.** A `revalidateTag("repos")` call now invalidates the entire header-chrome in one operation; previously the three slots could in principle be invalidated out of order (the API routes' `revalidateTag` calls are synchronous but the cache-slot lifecycle is best-effort), leading to a brief window where one accessor could serve fresh data and another stale. The single-slot design eliminates that.
- **The 3-test new describe block in `queries.test.ts` is the regression net.** A future refactor that splits the function back into three (or moves to a different `cachedRead` key) will fail these tests on the first commit.
- **No new failure mode.** The new function uses the same `Promise.all` + `unstable_cache` pattern the existing cached reads use; the per-statement `getSkippedRepos` call is unchanged. The `count(*) filter (where …)` pattern is standard SQL and works in Postgres 14+ (the project runs 18).

## Alternatives considered

| Decision                             | Alternative                                                          | Why not                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One cache slot, two statements       | One cache slot, one CTE / JSON aggregation                           | A CTE that returns both scalars _and_ the skipped list as a `json_agg` saves one more round-trip (1 instead of 2) at the cost of an extra `json_agg` cast layer at the boundary. The two-statement form keeps each query's result shape exactly what the legacy functions returned, which makes the migration's back-compat story trivial. |
| One cache slot, two statements       | Three independent cached reads, kept as-is                           | The original problem. Three round-trips, three slots, three keys. Same 60 s TTL and tag, but no consolidation.                                                                                                                                                                                                                             |
| Re-export the three legacy functions | Drop the three legacy exports, force every caller to use the new one | Two pages and one test file use them today; a future caller (a CLI command, a script, a future page) might only need one slice. The thin-accessor pattern is one line of code per export and keeps the public surface stable.                                                                                                              |
| Switch to a SQL-only aggregation     | Use `json_agg` for the skipped list inside the count statement       | Mixing scalar projections with a row-typed `json_agg` in the same `SELECT` works but the cast/parse at the boundary is uglier than a separate `getSkippedRepos` call. The `Promise.all` pair is also a smaller delta from the current code shape.                                                                                          |
| 60 s TTL vs shorter                  | 30 s TTL (matches the mission-action rate limiter)                   | The 60 s TTL is set by ADR 0033 and the cache-invalidation matrix it documents. Changing it here is a different ADR's work; the consolidation changes the shape of the cached read, not the freshness contract.                                                                                                                            |

## Live verification (2026-08-29)

Ego-browser verification of the three pages against `localhost:3000` confirmed the consolidated read renders correctly:

- `/` header chrome: **"6 repos indexed"** (rendered via `getRepoDirectorySummary().indexedCount`). 6 repo cards listed with severity counts and ecosystem badges intact. The `totalCount` (6) and `skippedRepos` (3, not shown on the home page since the disclosure section only renders when `skippedRepos.length > 0` and the home page only renders `totalRepoCount` and `skippedRepos`) fields both populated from the same cached read.
- `/missions` header chrome: **"6 repos indexed | 3 skipped"** (rendered via `getRepoDirectorySummary().indexedCount` and `getRepoDirectorySummary().skippedRepos`). 177 total missions across all axes, "1–50 of 177 missions" range line, all four filter axes + sort + group-by rendering, composite-score ordering preserved.
- `/repo/SpIob/FlowState` — per-repo page renders unchanged; the per-repo page uses `getRepoBoardPage()` + `getBookmarkedRepoIds()` + `getRepoEcosystems()` directly, none of which the consolidation touched.

No error boundaries triggered on any of the three pages. The `count(*) filter (where ingestion_status = 'complete')::int` + `count(*)::int` two-scalar statement (the new shape) and the unchanged `getSkippedRepos` query both succeed against dev Neon. The cache-invalidation matrix (cached-read.ts:14-31) is unchanged — every route that already calls `revalidateTag("repos")` invalidates the new `["repo-directory-summary"]` slot without any code change.

---

_End of document._
