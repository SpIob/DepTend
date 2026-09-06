# ADR 0053: Directory per-severity buckets must include advisory-less missions

**Status:** Accepted
**Date:** 2026-09-05

**Verified:** Live query against the dev database (`DATABASE_URL` from
`.env.local`), run as the new "real Postgres" describe block in
`packages/core/src/db/queries.test.ts`:

```
✓ src/db/queries.test.ts (31 tests) 3198ms
  ✓ getBoardMissionsWithScoresPage against real Postgres > executes every sort mode's ORDER BY without a Postgres type error 1870ms
  ✓ getRepoDirectoryBase against real Postgres (ADR 0053) > returns severity counts that match the per-repo Impact facet (no advisory-less mission is dropped) 1206ms
```

The second test iterates `getRepoDirectoryBase()` over every repo on
dev and asserts `repo.missionCounts.total === perRepoPage.total` for
each — the directory's reported total now agrees with the per-repo
board's total for every repo, which is exactly the invariant that was
violated by `SpIob/FlowState` (51 vs 75) and `psf/requests` (48 vs 51) on the deployed site before this fix.

Direct SQL cross-check against dev Neon (2026-09-05):

```
[
  { "repo": "SpIob/FlowState",                  "total": "75", "unknown": "24" },
  { "repo": "SpIob/StockWatch",                 "total": "116", "unknown": "28" },
  { "repo": "SpIob/deptend-go-test-fixture",    "total": "58", "unknown": "32" },
  { "repo": "SpIob/deptend-nullrepo-test-fixture","total": "2", "unknown": "1" },
  { "repo": "SpIob/deptend-pypi-test-fixture",  "total": "8",  "unknown": "4" },
  { "repo": "psf/requests",                     "total": "51", "unknown": "15" }
]
```

Pre-fix the home card's `1 critical + 17 high + 29 medium + 4 low =
51` row for `SpIob/FlowState` would have rendered with no
`unknown` line at all — the `unknown` bucket was being silently
bucketed under a JS-phantom `null` property and dropped. Post-fix
the card renders `1 critical + 17 high + 29 medium + 4 low +
24 unknown = 75`, matching the per-repo Impact facet exactly.

---

## Context

The 2026-09-05 production QA pass on `deptend.vercel.app` found that the
home-page repo directory silently undercounts missions for repos whose
missions include advisory-less rows. The bug surfaces on every repo that
has at least one `dep_update`, `maintenance`, or `license_issue` mission
(open or claimed), which today is every repo with a non-trivial
dependency-update cadence — `SpIob/FlowState` and `psf/requests` are the
two live examples.

`packages/core/src/db/queries.ts:768-787` (`getRepoDirectoryBase`) builds
the per-severity tally with:

```ts
.from(missions)
.innerJoin(advisories, eq(missions.advisoryId, advisories.id))
.where(inArray(missions.status, ["open", "claimed"]))
.groupBy(missions.repoId, advisories.severity)
```

Two ways this silently drops rows:

1. **Missions with `advisory_id = NULL`** (every `dep_update`,
   `maintenance`, and `license_issue` row, per schema.ts:269's nullable
   `advisoryId` with `ON DELETE SET NULL`) are excluded by the
   `INNER JOIN`. Postgres never returns them at all.

2. **Missions with `advisory_id` non-null but
   `advisories.severity IS NULL`** are returned but grouped under a
   SQL-NULL bucket; the JS aggregation `counts[row.severity] += row.count`
   coerces `row.severity === null` to a phantom `counts["null"]` property
   that no `Severity` literal ever reads, so those rows are counted into
   `total` but never reach any of the `critical/high/medium/low/unknown`
   buckets.

`app/src/components/repo-card.tsx:30` then filters
`SEVERITY_ORDER.filter((s) => counts[s] > 0)`, which drops the
zero-valued `unknown` bucket. The card therefore renders a count
summary whose visible numbers sum to fewer missions than the repo
actually has open.

### Live evidence on the deployed site, 2026-09-05

| Repo                            | Card shows (sum)              | Per-repo page facet says total                              | Type facet says total                             |
| ------------------------------- | ----------------------------- | ----------------------------------------------------------- | ------------------------------------------------- |
| `SpIob/FlowState`               | 1 + 17 + 29 + 4 = **51**      | Critical(1) High(17) Medium(29) Low(4) Unknown(24) = **75** | VulnFix(51) DepUpdate(21) Maintenance(3) = **75** |
| `psf/requests`                  | 1 + 13 + 20 + 2 + 12 = **48** | Critical(1) High(13) Medium(20) Low(2) Unknown(15) = **51** | VulnFix(48) DepUpdate(3) = **51**                 |
| `SpIob/deptend-go-test-fixture` | 8 + 9 + 9 + 32 = **58**       | Critical(8) High(9) Medium(9) Unknown(32) = **58**          | VulnFix(58) = **58**                              |

The discrepancy on the first two is exactly the **21 dep_update + 3
maintenance** (FlowState) and **3 dep_update** (psf/requests) missions
the directory silently drops. The third repo accidentally looks correct
because all 58 of its open+claimed missions have a non-null severity.

The board-wide listing already does this right —
`BOARD_SEVERITY_EXPR = sql<string>\`COALESCE(${advisories.severity}::text, 'unknown')\``(queries.ts:260) — and the per-repo`Impact`facet (which uses the same
expression via`runBoardTally`) shows the correct totals. The
mismatch between the board/per-repo facet and the directory card is the
bug.

### Why it matters

The repo directory is the project's primary scan surface (AGENTS.md §2
calls `/` the "default landing page"). A user looking at `SpIob/FlowState`'s
card and seeing `51 missions` would reasonably conclude "not a lot to fix,"
drill in, and find **24 missions under `Unknown` severity they had no
signal for on the scan surface** — including the 21 `Dependency Update`
missions that the project's own filter labels `dep_update` mission type
on the per-repo board. The card's count is therefore worse than just
incomplete: it actively misleads a scan-driven reader into skipping
repos with substantial maintenance backlog.

The transparency-first non-negotiable (AGENTS.md §1) also fails here:
the home card's per-severity numbers are the most public summary the
project ships, and they are wrong.

---

## Decision

Replace the directory's per-severity tally with a `LEFT JOIN` + a
`COALESCE(advisories.severity, 'unknown')` expression that mirrors the
board-wide `BOARD_SEVERITY_EXPR`. Both sub-queries (with and without the
optional `orgLogin` scope) move from:

```ts
.from(missions)
.innerJoin(advisories, eq(missions.advisoryId, advisories.id))
.where(inArray(missions.status, ["open", "claimed"]))
.groupBy(missions.repoId, advisories.severity)
```

to:

```ts
.from(missions)
.leftJoin(advisories, eq(missions.advisoryId, advisories.id))
.where(inArray(missions.status, ["open", "claimed"]))
.groupBy(
  missions.repoId,
  sql<string>`COALESCE(${advisories.severity}::text, 'unknown')`,
)
```

…and the `severity:` projection becomes:

```ts
severity: sql<string>`COALESCE(${advisories.severity}::text, 'unknown')`,
```

The JS-side aggregation loop (`counts[row.severity] += row.count`)
stays the same. With COALESCE in place, `row.severity` is now a
non-null `string` (one of the five `Severity` literals) instead of
`string | null`, so the phantom `counts["null"]` property is no longer
reachable — `counts.unknown` correctly receives the bucket that the old
implementation was dropping.

The board query's `Severity` import (`severityEnum.enumValues` is
already imported for the facets in `buildBoardTallySelect`, queries.ts:415)
is not needed here because the SQL string is hard-coded; the JS loop
keeps working off the same `Severity` keys.

The existing `getRepoDirectoryBase` test (`queries.test.ts:706-725`) keeps
passing as-is because the test mocks already return strings for the
`severity` column — they happen to exercise the happy path (no null
severities). A new test is added to pin the fix:

- A mock with one row `["r-1", "unknown", 5]` asserts the result's
  `missionCounts.unknown === 5` and `missionCounts.total === 5`. Without
  the COALESCE the loop's `counts[null] += 5` would silently leak and
  the test would fail.
- The captured SQL is asserted to contain `leftJoin`-equivalent text
  (`left join "advisories"`) and `COALESCE`. AGENTS.md §6 meta-lesson:
  assert SQL text **and** a live-Postgres run, since a type mismatch in
  the COALESCE cast would compile and run green against the fake
  transport.

### Live verification

Per AGENTS.md §6's "meta-lesson worth internalizing" and §10's "live
verification before Accepted", the ADR flips to Accepted only after a
run against the dev Neon database confirms the directory now reports
75 / 51 / 58 for the three live repos (matching the per-repo page's
facet totals). The dev Neon block at the bottom of `queries.test.ts`
already exists for sort-mode smoke testing — the same opt-in path
(`DATABASE_URL` from `.env.local`) is reused for a
`getRepoDirectoryBase` call here.

The smoke job in `.github/workflows/ci.yml` covers the
live-render side: the production `/` directory's card for each of the
three repos is fetched and asserted to be 200 + non-404, so a regression
in this code path that surfaced as an error boundary would be caught
by CI rather than only on the live site.

---

## Why not the alternatives

**A. Move the directory's tally into the board query's `LEFT JOIN`
shape one statement at a time** — same SQL, no schema change. This is
what the decision does; rejecting any more elaborate rework.

**B. Compute the per-severity counts in JS from the full mission list.**
Rejected: the directory is intentionally cheaper than `getRepoMissionsWithScores`
(a constant-time summary vs. a payload that scales with mission count, ADR
0027 + ADR 0033). It already runs under `cachedRead` with a 60 s TTL;
adding a fifth un-indexed sub-query would either extend the cache miss
cost or break the per-repo bounds this comment block calls out (queries.ts:711-732).

**C. Add a `missionCounts` column on `repos` and write through the
ingestor / scorer.** Rejected. It's the right shape long-term — every
read path would be a constant index lookup instead of a tally — but it
adds a write-path contract the scorer's per-row writes would have to
keep honest. ADR 0043 just landed a similar "single bulk UPDATE" change
for a related aggregator, so a write-path version isn't out of the
question, but it's its own ADR and its own migration. This ADR fixes
the read-side bug at its smallest blast radius: the SQL the directory
already runs.

**D. Drop the `critical/high/medium/low/unknown` breakdown from the
card entirely and show only `total`.** Rejected: the breakdown is the
board's primary visual cue for "is this repo in trouble" (a `30 critical`
card reads very differently from a `30 low`), and the underlying counts
are correct on `deptend-go-test-fixture`. The right move is to fix the
query, not to delete the information.

---

## Operational notes

- No migration. The schema is unchanged (`advisoryId` is already
  nullable, indexes unchanged).
- Cache invalidation is automatic: `cachedRead(... "repos" ...)`
  revalidates on `revalidateTag("repos")`, which the existing routes
  (`submitRepo`, `withdrawOwnRepo`, notification subscribe/unsubscribe)
  already call on success. The new query result is keyed on the same
  tag.
- Performance: `LEFT JOIN` against `advisories` on an indexed FK is no
  different from `INNER JOIN` for the planner; the extra rows it returns
  are aggregated in the same `GROUP BY`. The query is also already
  bounded by repo cap (ADR 0028's 150-repo limit), so the row count is
  small either way.
