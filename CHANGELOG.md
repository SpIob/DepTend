# Changelog

All notable changes to DepTend, condensed to one entry per phase.

**Conventions used here:**

- No semver; `package.json`'s version has stayed `0.0.1` throughout; a fake version number per entry would misrepresent a project that's never cut a release. Entries are dated by phase-completion date instead.
- This is a **condensed** summary; major, user- or developer-facing changes only. For full detail, alternatives considered, and retroactive fixes, see the corresponding ADR(s) linked in each entry, or the phase status docs for Phases 0–6.
- Ordered newest first.

---

**2026-08-30 — Server-Timing header + `/org/[org]` actually rendering**

Two production observability / data-shape fixes from the 5-round perf
test series on 2026-08-30. See `reports/perf/2026-08-30/compare.md` for
the lab data. Per ADRs 0047 (post-deploy live verification) and 0052.

### Fixed

- **`/org/[org]` was a 404 in production for every known org.** The
  `organizations` table was empty, and `repos.org_id` was `NULL` for
  all 4 known repos. The `scripts/backfill-orgs.mjs` script (ADR 0047)
  had never actually been run against production, so the per-org
  directory page (which calls `notFound()` when `getOrganizationByLogin`
  returns `null`) served a 404 body for `/org/SpIob` and `/org/psf`. The
  same diagnostic found a separate bug in the backfill itself: the
  script reads `process.env.DATABASE_URL` (pooled PgBouncer) but
  needs the unpooled `DATABASE_URL_UNPOOLED` to see the data it is
  supposed to update; the documented usage was a silent no-op. The
  2026-08-30 run used `DATABASE_URL=$DATABASE_URL_UNPOOLED` and
  populated 2 org rows (SpIob, psf) and linked 4 repos. The env-var
  bug is a separate follow-up commit. Verification: every
  `/org/SpIob` and `/org/psf` request now renders the directory
  (Lighthouse perf 100/100 cold + warm; 3 and 1 repo cards respectively).

### Added

- `Server-Timing: total;dur=<ms>` response header on every non-asset
  request, set in `app/src/middleware.ts`. Surfaces the
  middleware-phase wall-clock cost on every page; the cache-hit vs
  cache-miss gap remains invisible at the response level (a follow-up
  ADR is flagged in 0052 for per-segment timing if the operational
  need arises). AGENTS.md §12 gains a one-line note that any new
  expensive sync work in middleware is now visible in the header.
- `docs/adr/0052-server-timing.md` — ADR for the header.

---

## [Unreleased]

**UI audit fixes — board interaction, top-level 404, low-confidence color, mission disambiguation (2026-08-30)**

Four findings from a 2026-08-30 anonymous UI audit, fixed in one pass.
Per ADRs 0048–0051.

### Fixed

- **Top-level 404 pages render blank.** A mistyped URL (e.g.
  `/totally-not-a-real-page`, `/x`) returned HTTP 404 with a body
  containing only the RSC payload — no `<main>`, no `<h1>`, no
  visible content, empty tab title. Caused by Next 15.5's behavior
  for routes that don't match any file under `app/src/app/`. The
  existing `app/src/app/not-found.tsx` is correct; it just wasn't
  being reached. Fixed by adding `app/src/app/[...slug]/page.tsx`,
  a one-line catch-all that calls `notFound()`, so every
  unrecognized URL routes through the same styled 404 page with
  "Browse repos" / "All missions" CTAs. ADR 0048.

- **Mission board filter interactions stalled on rapid clicks.**
  `useTransition` + `router.replace` would queue a second
  navigation behind the first, and the queue wouldn't clear until
  the Vercel free-tier Neon round-trip (~20s) finished. The "Updating…"
  indicator would stay on indefinitely, the URL wouldn't change.
  Fixed in `app/src/components/paginated-mission-board.tsx:155-211`
  by replacing the transition wrapper with imperative `router.replace`
  and an `inFlight` counter that the "fresh missions array arrived"
  check decrements on each settled server response. Same UX, same
  indicator, no more queueing. ADR 0049.

- **Low-confidence "Why this score?" header reuses the
  `severity-high` red.** On the mission card, the "Why low
  confidence" notes header was `text-severity-high font-semibold`
  (red bold), the same color as the `severity-critical` bar. A
  user scanning the board could read a low-confidence header on a
  critical-severity card as "the severity is critical, the score
  is just low" — same hue, two different signals. Fixed in
  `app/src/components/mission-card.tsx:428-431` by using the
  unused `text-ink-muted` style with a small `border-l-2
border-severity-high` accent. Same red cue at the eye-line,
  different foreground (no longer claims to be severity). ADR 0050.

- **Multiple same-severity-same-package advisories produce
  identical card summaries.** On `/missions?severity=critical`,
  7 of 10 cards had title "Update golang.org/x/crypto to fix a
  critical vulnerability" + same `Fix: 0.52.0`; the user had to
  expand the card to read the OSV ID in the Source section.
  Fixed in `app/src/components/mission-card.tsx:276-281` by
  appending the short OSV prefix (e.g. "(GHSA-x527)") to the
  card title when the title and fix version alone wouldn't
  disambiguate. The full OSV ID is still in the Source line in
  the body; the title gets just enough to tell rows apart at a
  glance. ADR 0051.

### Added

- `app/src/app/[...slug]/page.tsx` — top-level catch-all that
  forces the not-found boundary to render for any URL Next
  doesn't recognize. Two lines of executable code; full
  rationale in the JSDoc and ADR 0048.
- `docs/adr/0048-catch-all-not-found.md` — ADR for the 404 fix.
- `docs/adr/0049-imperative-router-replace.md` — ADR for the
  inFlight counter pattern.
- `docs/adr/0050-low-confidence-color.md` — ADR for the color
  decoupling.
- `docs/adr/0051-osv-id-in-title.md` — ADR for the title
  disambiguation.

---

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
