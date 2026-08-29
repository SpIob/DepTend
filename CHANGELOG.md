# Changelog

All notable changes to DepTend, condensed to one entry per phase.

**Conventions used here:**

- No semver; `package.json`'s version has stayed `0.0.1` throughout; a fake version number per entry would misrepresent a project that's never cut a release. Entries are dated by phase-completion date instead.
- This is a **condensed** summary; major, user- or developer-facing changes only. For full detail, alternatives considered, and retroactive fixes, see the corresponding ADR(s) linked in each entry, or the phase status docs for Phases 0–6.
- Ordered newest first.

---

## [Unreleased]

**Per-org directory page + per-repo truncation fix (2026-08-29)**

Two UI-test findings fixed in one pass: the `/org/[org]` route was
serving a permanent loading skeleton (the `organizations` table was
empty in production from day one — every repo's `org_id` was NULL
because the ingestion pipeline never fetched GitHub-side org metadata);
and the per-repo page was silently dropping missions at 50
(BOARD_PAGE_SIZE) without showing a range line. Per ADR 0047.

### Fixed

- **Per-repo page truncation.** `app/src/app/repo/[owner]/[name]/page.tsx:97`
  now passes a non-default `limit: 1000` to `getRepoBoardPage`; the
  per-repo page suppresses pagination so the result is rendered whole.
  `app/src/lib/queries/missions.ts:133-148` threads the `options`
  parameter through. The per-repo JSDoc on `getRepoBoardPage` notes
  that the per-repo caller passes its own limit. ADR 0031's `/missions`
  pagination is unaffected. Two repos in the dev DB were affected:
  `SpIob/deptend-go-test-fixture` (55 missions, 5 dropped → fixed) and
  `psf/requests` (51, 1 dropped → fixed). Same bug on `deptend.vercel.app`.

- **`/org/[org]` route rendering.** The `organizations` table is now
  populated by the ingestion pipeline (every newly-ingested repo
  upserts its owner profile via `lookupGitHubOwnerMeta` in parallel
  with the existing `fetchGitHubRepoMeta` call). The writer's
  `WriteIngestionInput` gains an optional `org` field; the org-upsert
  step is a no-op when callers don't pass it. A one-time
  `scripts/backfill-orgs.mjs` walks every existing repo with
  `org_id IS NULL` and populates them. The org page is unchanged — it
  just starts rendering data once the schema is populated.

### Added

- `packages/core/src/ingestor/github-org-meta.ts` —
  `lookupGitHubOwnerMeta(login, token, options?)`. `GET /orgs/{login}`
  with a `GET /users/{login}` fallback for personal accounts. Same
  rate-limit / typed-error / fetch-retry story as `fetchGitHubRepoMeta`.
- `scripts/backfill-orgs.mjs` — one-time backfill script. Idempotent.
- `docs/adr/0047-populate-organizations.md` — ADR with full context and
  the implementation walkthrough.

### Tests

- `packages/core/src/ingestor/github-org-meta.test.ts` — 8 new tests
  covering the org / user fallthrough, both 404s, rate-limit
  classification, Authorization header, URL-encoding, and 5xx
  propagation.
- `packages/core/src/ingestor/writer.test.ts` — 2 new tests in a
  new "write — org step (ADR 0047)" describe block, covering
  `input.org` provided (upsert + set orgId) and not provided (no-op).

### Pre-existing test/lint rot in the WIP (NOT touched by this change)

- `pnpm test` is green: 952 tests passing across 55 test files.
- `pnpm typecheck` is green: 0 errors.
- `pnpm lint` has 3 pre-existing errors in `packages/core/src/ingestor/writer.ts:74,364`
  and `cli/src/build-rows.ts:68` — the `NpmRegistryFetchResult | PyPIRegistryFetchResult`
  union is now flagged as a "duplicate type constituent" by the
  `no-duplicate-type-constituents` rule in the lockfile-bumped
  `typescript-eslint`. Both `NpmRegistryFetchResult` and `PyPIRegistryFetchResult`
  are aliases of the same `RegistryFetchResult` interface, so the
  union is structurally redundant. The WIP's call site already comments
  on this. Per AGENTS.md §0, this is a decision point — picking
  whether to consolidate the type aliases into one shared export —
  not fixed in this pass.

---

**Mission board perf pass (2026-08-29)**

Two independent changes that target the board's two highest-cost shared
reads. The mission board itself (per-row `priority` ORDER BY) and the
header-chrome on `/` and `/missions` (`indexed` / `total` / `skipped`
counts) are the only reads a cold cache miss is forced to do on every
request that ADR 0033 doesn't serve from `unstable_cache`. Tier 1 from
the standing perf review. No public-API change; the new migration adds
one index.

### Added

- `idx_mission_scores_composite_tier` — a btree on the
  `FLOOR(composite_score / 0.5) DESC` expression that mirrors
  `scorer/ranking.ts:compositeTier()` and the board's `BOARD_TIER_EXPR`
  in `queries.ts`. Lets the planner replace the board's full-sort step
