# Changelog

All notable changes to DepTend, condensed to one entry per phase.

**Conventions used here:**

- No semver; `package.json`'s version has stayed `0.0.1` throughout; a fake version number per entry would misrepresent a project that's never cut a release. Entries are dated by phase-completion date instead.
- This is a **condensed** summary; major, user- or developer-facing changes only. For full detail, alternatives considered, and retroactive fixes, see the corresponding ADR(s) linked in each entry, or the phase status docs for Phases 0–6.
- Ordered newest first.

---

**2026-09-05 — CLI B1, B3, B4, B6-B10 fixes from the 2026-09-05 audit**

The 2026-09-05 CLI audit
(`reports/cli-audit-2026-09-05/REPORT.md`) found eight gaps in the
`@deptend/cli` analyze pipeline that the mocked test suite missed
because the mocks didn't match the real-network contract (the same
class of bug the audit series has surfaced across the project; see
AGENTS.md §12, 'Mocks must match the real contract'). This pass
fixes them and pins the contracts with new live-network-aware
unit tests.

### Fixed

- **B1** (`--github-url` missing-value check) and **B3**
  (duplicate-flag detection) — `parseArgs` in `cli/src/index.ts`
  now throws on missing required values (was: silently forwarded
  `undefined`) and on duplicate flags (was: last-write-wins).
  Both are now covered by `cli/src/index.test.ts` (new file).
- **B4** (advisory URL hard-coded to osv.dev) — `cli/src/analyze.ts`
  now routes GHSA-sourced advisories to
  `github.com/advisories/{id}` and OSV-sourced to
  `osv.dev/vulnerability/{id}`, matching the
  `AdvisorySource` enum on the row. The 2026-09-05 audit showed
  every GHSA row's URL was silently wrong.
- **B6** (`GITHUB_TOKEN` warning) — `cli/src/index.ts` now
  prints the same `scripts/ingest.js`-style warning when
  GITHUB_TOKEN is unset, instead of silently rate-limiting at
  60 req/hr.
- **B7** (`--json` default), **B8** (osv_id disambiguation in
  human summary), **B9** (effort_label glyph prefix so
  `trivial`/`low` don't render as visually identical),
  **B10** (TTY + NO_COLOR gating for ANSI) — all in
  `cli/src/output.ts`, pinned by `cli/src/output.test.ts`
  (new file).

---

**2026-09-05 — Replace inline worker pool in `changelog-signals.ts` with `runBounded`**

`prefetchEffortSignals` in `packages/core/src/ingestor/changelog-signals.ts`
had its own bounded-concurrency worker pool (~28 LOC: a closure over a
shared `index` counter plus a `Promise.all` of `worker()` calls).
Same shape as `concurrency.ts:runBounded`, but keyed by `request.key`
rather than input index. Replaced the inline loop with `runBounded` and
a small post-loop that zips results back to keys. The dedup-by-key
preprocessing that ran before the worker pool stays; only the
concurrency primitive is now shared. No behavior change; the existing
`changelog-signals.test.ts` exercises the contract.

---

**2026-09-05 — Remove single-implementation scorer interfaces**

`packages/core/src/scorer/interface.ts` (46 LOC) defined three
contracts (`ImpactScorer`, `EffortScorer`, `EcosystemValueScorer`),
each with exactly one implementation in the same package. In eight
phases no alternate implementation has been written, no test mocks
the interface, and no consumer ever passes the interface type around.
The result-shape interfaces (`ImpactScoreResult`, `EffortScoreResult`,
`EcosystemValueScoreResult`) moved inline to the concrete
`Default*Scorer` files; the three single-implementation contracts are
gone. The composition site in `mission-scorer.ts` keeps a two-line
code comment naming the rule for reintroduction.

---

**2026-09-05 — Inline `clamp` from `scorer/transforms.ts`**

Ponytail rung 6. The helper was a one-line `Math.min(Math.max(...))`
used at four call sites across three scorer files. Deleted
`packages/core/src/scorer/transforms.ts`; the call sites now inline
the expression. No behavior change, no public-API change — `clamp`
was only used inside the scorer.

---

**2026-09-05 — Remove dead code and unused exported types from `@deptend/core`**

Pure deletions and inlinings across the core package. No schema, no
behavior, no contract change for any external caller — the public
function signatures are byte-identical (return types inlined as
structural shapes, intermediate type aliases removed).

### Removed

- `packages/core/src/db/organization-members.ts` (109 LOC) — five
  `*Member` helpers; zero importers. The `organization_members` table
  and its `$inferSelect`/`$inferInsert` types stay.
- `getRepoDirectoryBaseByOrg` and `getReposWithMissionSummary` in
  `queries.ts` (26 LOC) — both documented as backwards-compatible
  shims around `getRepoDirectoryBase`; neither had a current caller
  in `app/`, `cli/`, or `scripts/`. The `/app` cached wrapper of the
  same name in `app/src/lib/queries/missions.ts` is a separate
  function and stays.
- `getRepoDirectoryBaseByOrg` test block in `queries.test.ts`.
- `db/organization-members.js` subpath export in
  `packages/core/package.json`.
- `getSubscription`, `getRepoSubscriptions`, and
  `updateSubscriptionIssueNumber` from
  `packages/core/src/notifications/subscriptions.ts` — zero external
  consumers. `getUserSubscriptions` stays (used internally by
  `queries.ts`).

### Inlined

- `AnyNeonTx` (1 line, `db-types.ts`) — used only by the file-local
  `DbOrTx` definition; the `NeonTransaction<any, any>` reference is
  now inline. `AnyNeonDb` stays (used by both writers).
- Outcome-type unions in `db/missions.ts`, `db/bookmarks.ts`,
  `db/repos.ts`, and `notifications/subscriptions.ts` — all
  function-return-type aliases that no route imported. Functions
  now return inline string-literal unions (same shape, same
  exhaustiveness). The four `Subscribe*` / `WithdrawRepoOutcome`
  unions in `subscriptions.ts` and `repos.ts` were kept as inline
  literal unions on the relevant function/helper signatures.
- `ParsedGithubUrl`, `SubmitRepoParams`, `SubmitRepoResult` in
  `db/repos.ts` — structural shapes used only by `parseGithubUrl` /
  `submitRepo`. Now inline in their function signatures; the test
  file picks them up via `Parameters<typeof submitRepo>[1]`.

### Misc

- `schema.ts:510-511` duplicate `// Enum value types` header banner
  (the comment block on lines 507–509 was the proper banner; the
  stray line was a leftover edit artifact).
- `validation.ts` JSDoc: dropped the sentence claiming
  `missions.ts` re-exports `isValidMissionId` as an alias — the
  alias was removed in the 2026-09-04 pass and the comment never
  caught up. Same fix in `missions.test.ts:75`.

---

**2026-09-05 — Fix stale "lock-file parsing is not implemented" wording**

Three references in `packages/core/src/scorer/mission-scorer.ts` (lines
134–139, 255, 524–528) and one in `cli/src/output.test.ts` (line 51) said
lock-file parsing was still deferred. ADR 0038 is `Accepted` and the
parsers are live. Updated the comments and the user-facing
`confidence_notes` text to point at ADR 0038 and name pnpm as the
remaining gap, not a "deferred" claim. The note text change is the
user-visible part; comments are dev-only.

### Changed

- `mission-scorer.ts` — `inferSemverBump` and `inferPep440Bump` doc comments
  reworded to describe the lock-file path as conditional, not "always
  null until it lands."
- `mission-scorer.ts` — `buildConfidenceNotes` for the `no_lock_file` branch
  reworded the user-facing sentence and the explanatory comment that cited
  "AGENTS.md §11" (which was itself already corrected in the 2026-09-05 doc
  audit). New text: "ADR 0038 covers most formats; pnpm and unparseable
  files are the remaining gaps."
- `cli/src/output.test.ts` — fixture note string updated to match the new
  wording.
- `cli/src/analyze.test.ts` — explanatory comment reworded to drop the
  "no lock-file parsing exists yet" phrasing; the substantive assertions
  are unchanged.

---

**2026-09-05 — Documentation audit + 5 stale-ADR flips (no behavior changes)**

A targeted read-only pass that found five ADRs whose `Status: Proposed`
headers disagreed with the implementation in source and the verification
evidence already in the repo. Per AGENTS.md §10, an ADR flips to Accepted
when live verification has been performed; for each, the evidence was
already on file (a colocated test, a live-Neon block gated on
`DATABASE_URL`, an end-to-end re-ingest report). No code change ships in
this pass; the diff is doc-only.

### Fixed

- **ADR 0033** (`read-path caching`): `reviveDates` placement regression
  was already shipped and the `2026-08-30` perf series
  (`reports/perf/2026-08-30/compare.md`) confirmed `/` and `/missions`
  render with dates. Header now reads `Accepted` with verification
  citations.
- **ADR 0035** (`missions.dependency_id` index): migration
  `0006_add_missions_dependency_id_index.sql` applied; index declared in
  `schema.ts:286`; data-model changelog already records the ship at 0.1.7.
  Header now reads `Accepted`.
- **ADR 0038** (`lock-file parsing`): six per-ecosystem parsers ship
  (`npm-lock-parse.ts`, `yarn-lock-parse.ts`, `poetry-lock-parse.ts`,
  `pipfile-lock-parse.ts`, `pdm-lock-parse.ts`, `go-sum-parse.ts`) with
  colocated tests; `writer.ts:376,393` populates `resolved_version`;
  `mission-scorer.ts:421,468` consumes it. End-to-end live verification:
  `reports/perf/2026-09-04-prod-vs-dev/d1-dev-reingest-verification.md`
  (all 6 status=complete dev repos re-ingested with
  `LIBRARIES_IO_API_KEY`; 128/310 dev missions reached
  `confidence: "medium"`). Header now reads `Accepted`.
- **ADR 0041** (`parallel ecosystem detection`): `detect.ts:1-239` runs
  probes concurrently with `AbortController` plumbing; `detect.test.ts:1-308`
  covers tie-break, abort, and all-fail behavior. Header now reads
  `Accepted`.
- **ADR 0043** (`bulk mission writes`): `scorer/writer.ts:47` and the
  `bulkWriteMissions` / `bulkUpsertMissionScores` private methods; live-DB
  verification block at `writer.test.ts:952-984` (gated on `DATABASE_URL`).
  Header now reads `Accepted`.

### Doc-only

- **AGENTS.md §11** rewritten: lock-file parsing is no longer described as
  "fully deferred project-wide" (it shipped under ADR 0038); the
  `confidence` settled decision now lists ADR 0038 alongside 0029 and 0032
  and removes the "high requires lock-file parsing to land" caveat. The
  MAX_REPOS "all four" line is corrected to "both code fallbacks" (the
  two hardcoded `"150"` literals in `app/src/app/api/repos/route.ts:138`
  and `app/src/app/page.tsx:21-22`; the env-var sources are
  `Vercel env` and `.env.local`, and `scripts/ingest.js` deliberately
  bypasses the cap for `--repo-url` per ADR 0037, so it is not a third
  hardcoded fallback).
- **Reports em-dash sweep, partial**: 4 specific instances in
  `reports/cli-audit-2026-09-05/REPORT.md` and
  `reports/perf/2026-09-04-prod-vs-dev/{score-divergence-root-cause,
d1-dev-reingest-verification}.md` replaced per the AI-writing audit
  pass. The full corpus (~50 files, ~400 em dashes) is out of scope for a
  docs-only PR; flag a follow-up if the cleanup should be extended
  repo-wide.

---

**2026-09-05 — UI complexity reduction (no behavior changes)**

Mechanical refactor of `/app`'s UI and mutating API routes. The user-facing
behavior is unchanged; the verification gate (§6) is the only signal that
this happened. Per the no-ADR convention for refactors that don't
introduce new decisions.

### Changed

- **Mutating route preamble extracted to `app/src/lib/route-gate.ts`.**
  The 9 `[id]`-keyed mutating routes (4 mission + 5 repo) each opened
  with the same 25-line origin / session / rate-limit / UUID gate. Now
  they all call `gateRequest({...})` and continue from the returned
  `{ id, login }` pair. The four checks are the same as the test
  harness's `runSharedTests()` so the production contract and the test
  contract are derived from the same code path.
- **`<PageHeader>` component extracted.** The four public pages
  (`/`, `/missions`, `/repo/[owner]/[name]`, `/org/[org]`) each rendered
  the same `border-border flex flex-col gap-5 border-b pb-6` shell
  around a brand on the left and indexed-count + AuthStatus on the
  right. Now they pass `left` / `right` / `children` to a single
  component. Precedent: `BrandMark` was extracted the same way.
- **`MissionActions` mode switch.** The four `if (status === ...)`
  branches are now a single exhaustive `switch (mode)` on a 6-state
  discriminated union (`open-claimable`, `open-signed-out`,
  `claimed-by-me`, `claimed-by-other`, `dismissed-by-me`,
  `dismissed-signed-out`). Matches the §7 "exhaustive switches, no
  silent defaults" rule that already governs `WithdrawRepoOutcome` and
  `statusToOutcome()`.
- **`MissionScoreDetails` sub-component.** The 110-line "Why this
  score?" disclosure in `mission-card.tsx` is now its own sub-component
  in the same file. The three "Impact / Ecosystem value / Effort"
  input columns share a `<ScoreInputsList>` helper. The 15-line inline
  confidence-notes className ternary is replaced by named constants.
- **`FilterRow` helper in `paginated-mission-board.tsx`.** The four
  filter rows (Severity / Ecosystem / Effort / MissionType) that were
  near-identical 17-line blocks are now 4 lines of JSX each. The
  per-axis `toggledSet` + `navigate(buildHref({...}))` closure lives at
  the call site; the row owns the label + chip array.
- **`submit-repo-form.tsx` uses the shared `extractErrorMessage`** for
  the error path and a small `successMessage` helper for the success
  path. The previous local `extractMessage` conflated the two
  response shapes (`{ error }` for errors, `{ message }` for success).

### Verified

- `pnpm typecheck` (all workspaces, including `tsconfig.eslint.json`
  passes for `packages/core` and `cli`)
- `pnpm test` (162 tests pass, including all 9 mutating route suites
  and the `route-test-setup.ts` shared gates)
- `pnpm build` (clean `app/.next` + `packages/core/dist`)
- `pnpm lint --max-warnings 0`
- `pnpm format:check`

---

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

**Ingest cron regression fix + colocated test (2026-08-30)**

The scheduled ingest run at 09:40 UTC (workflow run 33304652258) failed
with `TypeError: Assignment to constant variable` at `scripts/ingest.js:293`
when re-ingesting the stale `psf/requests` repo. The same commit's own
"node --check" verification missed the bug because it's a runtime error,
not a parse error.

### Fixed

- **Ingest cron failed on every stale-complete repo.** The
  c32878f "SyntaxError bugfix" replaced a parse-time
  `const ghMeta = ghMeta.value` (which `node --check` would have
  caught) with a plain reassignment of the same name, but the outer
  `const [ghMeta, orgResult] = await Promise.allSettled([...])`
  destructure on the line above was never updated. The reassignment
  now throws at runtime, which is why the previous SyntaxError fix
  shipped green on typecheck/test/build/lint but red on the first
  stale-complete cron pick. Fixed by binding the allSettled tuple to
  `ghMetaResult` and unwrapping `.value` into a fresh `const ghMeta`
  on the next line. 2 lines of executable code; ~6 lines of comment
  trim. `scripts/ingest.js:251` also gains an `export` keyword (so
  the new test can call `ingestRepo` directly), and the `main()`
  call at the bottom is gated on `import.meta.url` so a test
  import doesn't kick off a real cron run. Live verification: a
  follow-up `workflow_dispatch` against `psf/requests` on the
  deployed site (per AGENTS.md §6's meta-lesson that mocks don't
  match real contracts).

### Added

- `scripts/ingest.test.js` — colocated regression test (1 test,
  runs in `pnpm --filter scripts test`). The test spies on
  `console.log` and asserts the bug-specific log line
  (`Ingestion failed: Assignment to constant variable`) never
  appears; this is the only assertion shape that catches the
  regression, because `ingestRepo`'s outer try/catch swallows
  the TypeError and `return false`s. With the fix in place the
  test passes; reverting the 2-line fix on the script makes the
  test fail with the exact log line. Empirical confirmation
  (verified locally on 2026-08-30).
- `scripts/vitest.config.mjs` — minimal vitest config for the new
  `scripts/` workspace member. File extension is `.mjs` (not `.ts`)
  on purpose: the project's ESLint config typed-lints every `.ts`
  file with a `parserOptions.project` entry, and `scripts/` has no
  tsconfig, so a `.ts` config would fail lint. `.mjs` sits inside
  the existing `scripts/**/*.{js,mjs}` block of `eslint.config.mjs`.
- `scripts/package.json` — gains a `test` script (the file already
  existed with just `{"type":"module"}`). Added to the pnpm
  workspace via `pnpm-workspace.yaml` so `pnpm -r test` picks it
  up; one new vitest as a devDep (already in the root's
  transitive resolution, now per-workspace for the new
  `scripts/` package).

### Tests

- `pnpm -r test` is green: 953 tests passing across 56 test files
  (was 952 / 55; +1 regression test, +1 test file).
- `pnpm typecheck`, `pnpm build`, `pnpm lint --max-warnings 0`,
  `pnpm format:check` all green.

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
