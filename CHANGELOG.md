# Changelog

All notable changes to DepTend, condensed to one entry per phase.

**Conventions used here:**

- No semver — `package.json`'s version has stayed `0.0.1` throughout; a fake version number per entry would misrepresent a project that's never cut a release. Entries are dated by phase-completion date instead.
- This is a **condensed** summary — major, user- or developer-facing changes only. For full detail, alternatives considered, and retroactive fixes, see the corresponding ADR(s) linked in each entry, or the phase status docs for Phases 0–6.
- Ordered newest first.

---

## [Unreleased]

**Mission board focus fix, accessibility pass, security hardening, docs truth-check**

### Fixed

- `/missions` search no longer loses focus mid-typing: the board stopped remounting on every debounced search commit (it was keyed by its full URL), filter chips/clear/pagination became real buttons behind one shared transition — also fixing invalid `aria-pressed` on links — and an "Updating…" status shows while a filter/sort/search navigation runs.
- Screen readers now hear async outcomes: `role="status"` regions on repo submission, bookmark, and withdrawal messages; `role="alert"` on claim/unclaim errors; a proper label on the submit-repo input; sign-in/out buttons ignore double-clicks.
- Stale docs corrected against source: README's confidence explainer claimed every mission sits at `low` and that downstream-dependents/breaking-change signals weren't wired up (both false since ADRs 0029/0032); CHANGELOG entries and ADR footers still read "Proposed"/"draft" after the Accepted flip; `docs/data-model/README.md` gained the two post-launch scoring inputs and lost stale `deptend.dev` branding (README too); AGENTS.md §6/§13 notes updated to match the root typecheck script and ADR statuses.

### Added

- Loading skeletons for `/` and `/repo/[owner]/[name]` instead of blank screens during Neon reads. `/missions` deliberately gets none: a page-level skeleton would swap out the search input mid-navigation.
- Ranking-parity unit suite for `db/queries.ts` (real Drizzle SQL against a fake transport): locks `getBoardMissionsWithScoresPage()`'s ORDER BY to `rankMissions()`'s key sequence, plus filter/facet/pagination/shaping behavior — the ADR 0031 lockstep tripwire previously lived only in manual testing.

### Changed

- Security hardening: `Content-Security-Policy-Report-Only` header added (an enforced policy needs nonce middleware — deferred until the report is clean), and `ingest.yml` routes `workflow_dispatch` inputs through `env:` instead of direct shell interpolation.

**Downstream dependents sourced via libraries.io** — `ADR 0032`

### Added

- `EcosystemValueInputs.downstream_dependents` is now real data for repos whose published package(s) libraries.io can link: one paced API call per analyzed repo per ingestion run (max count across monorepo links), gated on a new free-tier `LIBRARIES_IO_API_KEY` (Actions secret + `.env.local`). The confidence flag is now conditional — a resolved count, including a genuine 0, clears it. Repos that resolve drop to a single structural flag (`no_lock_file`) and reach **`medium` confidence for the first time since Phase 2**; everything else stays honestly `null` + flagged. CLI output is unchanged (no keys in the CLI by design).
- Correction to this log's own record: the ADR 0029 entry below claims missions could "reach medium" after that change; against source they couldn't — `downstream_dependents_unavailable` was the second of two always-set flags until this ADR.

**Server-side pagination for the mission board + repo hardening** — `ADR 0031`

### Added

- `/missions` is now server-filtered, -sorted, and -paginated (50/page): filters and sort live in the URL and run as SQL against core's new `getBoardMissionsWithScoresPage`, which also returns per-axis facet counts — replacing the version that shipped every open+claimed mission to the browser for client-side filtering. Per-repo boards are unchanged. Ordering mirrors `rankMissions()`'s ADR 0017/0018 key sequence in SQL.
- Route-level test suites for all six mutating API endpoints (`repos` submit incl. the full manifest pre-check status mapping, claim/unclaim, bookmark/unbookmark, withdraw) — closing the "near-zero `/app` route coverage" gap.
- Next.js error boundaries: route-segment `error.tsx`, root `global-error.tsx`, and a styled `not-found.tsx` (previously a thrown render or unknown URL got Next's default screens).
- The §6-step-6 `tsconfig.eslint.json` typechecks for `packages/core` and `cli` are wired into `ci.yml` as their own step.

### Changed

- `getIndexedRepoCount` / `getTotalRepoCount` use `count(*)` instead of loading every repo id into memory.

### Fixed

- The unbounded board query known issue: `/missions` DB read, payload, and client working set are now bounded per request regardless of total missions.

**Repo submission safeguards** — `ADR 0030`

### Added

- Manifest pre-check at submission: a repo with no analyzable `package.json`/`pyproject.toml`/`requirements.txt`/`go.mod` is now rejected before a row — and a repo-cap slot — is created, instead of silently landing as `ingestionStatus: "skipped"` later.
- Self-service withdrawal: a submitter can withdraw their own repo while it's still `pending`/`skipped`, without asking Mico to delete it by hand.

### Fixed

- `POST /api/repos` previously accepted a syntactically valid GitHub URL for a private, deleted, or nonexistent repo with no verification at all. The manifest pre-check's existence check closes this as a byproduct.

**Dead export removal** — `ADR 0031` follow-up

### Removed

- `getBoardMissionsWithScores()` (`packages/core/src/db/queries.ts`): the fetch-everything board query that ADR 0031's server-paginated `getBoardMissionsWithScoresPage()` superseded kept zero callers after that change. Historical mentions in ADRs 0019/0023/0027 stay as written — they were accurate when recorded.

---

## Post-Phase 6 — Launch Readiness — 2026-07-25 to 2026-08-03

Standalone work between the phase plan's Phase 6 close and public launch, not tied to a numbered phase. `ADR 0023`–`0029`.

### Added

- **Go** added as a third supported ecosystem (`go.mod` parsing, Go module proxy registry lookups) — `ADR 0024`.
- In-memory, per-session rate limiting on all mutating endpoints (repo submission, claim/unclaim, bookmark/unbookmark) — zero-budget, keyed on authenticated GitHub login rather than IP — `ADR 0025`.
- Repo directory / browse view with per-user bookmarks, addressing the mission board's single-flat-list scaling problem — `ADR 0027`.
- `breaking_change_signals` now sourced from real GitHub Releases data instead of a hardcoded empty default — `ADR 0029`.

### Changed

- Local development and production now use separate Neon database branches, closing a gap where the two had shared one database (and one dataset) since Phase 0 — `ADR 0023`.
- Repo cap raised from 10 to 150 ahead of public launch — `ADR 0028`.
- Mission `confidence` is no longer uniformly `"low"` for every mission. Missions with a resolvable dependency repo can now reach `"medium"` or, combined with a resolved lock file and CVSS score, `"high"` — the first time confidence has moved off `"low"` since Phase 2. (`downstream_dependents` remains unavailable, so `"low"` doesn't disappear project-wide.) — `ADR 0029`.

### Fixed

- `__drizzle_migrations` had fallen three records behind the database's real applied state (each of the last two schema changes had needed a manual Neon SQL Editor apply after `drizzle-kit migrate` hung). Backfilled and reconciled — `ADR 0026`.

---

## Phase 6 — PyPI Ecosystem Expansion — 2026-07-25

`ADR 0022`

### Added

- **PyPI** added as a second supported ecosystem: `pyproject.toml` (PEP 621) parsing, with `requirements.txt` as a fallback; PEP 440 version-range/bump handling.
- Ecosystem auto-detection by ordered probing (npm tried first, then PyPI) — no `repos.ecosystem` column; ecosystem is decided fresh per ingestion run.

### Fixed

- OSV's PyPI advisories were parsed as if they used npm's `SEMVER`-type ranges. PyPI actually returns `ECOSYSTEM`-type ranges — every PyPI advisory would have silently returned an empty affected-version list and no fixed version, forever, with no error.

---

## Phase 5 — Public Rescue Board — 2026-07-20 to 2026-07-22

`ADR 0019`–`0021`

### Added

- Public mission board: open and claimed missions across all indexed repos, filterable by severity and effort (this project's first client-side interactive component).
- Logged-in users can claim and unclaim missions.
- New `ingestionStatus: "skipped"` value, distinguishing a repo with no analyzable manifest from a genuine ingestion failure — repos that can never succeed no longer get retried forever by the nightly cron.

### Changed

- Repo cap raised from 3 to 10, based on an actual Neon storage measurement rather than the original estimate.

---

## Phase 4 — CLI Companion — 2026-07-18

`ADR 0016`–`0018`

### Added

- `@deptend/cli`: npx-runnable CLI that reproduces the dashboard's exact scoring/ranking output entirely in-memory from a local repo path, with JSON export. Not yet published to the npm registry.

### Fixed

- Mission ranking's tie-break comparator wasn't transitive — the same missions could sort into different orders depending on database return order. Fixed by bucketing composite scores into fixed-width tiers.
- The final ranking tie-break (`created_at`) never actually discriminated between missions from the same ingestion run, because Postgres' `now()` is fixed for a transaction's lifetime. Switched to the advisory's own `published_at`, with `osv_id` as an absolute fallback. Found via cross-validating the CLI's output against the live dashboard on real data — both had the bug.

---

## Phase 3 — MVP Dashboard — 2026-07-11

`ADR 0011`–`0015`

### Added

- Next.js dashboard live in production, GitHub OAuth login, repo submission flow, mission list with a "Why this score?" disclosure showing every scoring input.

### Changed

- Live at `deptend.vercel.app`, not `deptend.dev` — the domain remains unregistered (a small recurring cost against the zero-budget constraint) and `deptend.vercel.app` was made the project's permanent domain, not a placeholder.

### Fixed

- Tailwind CSS had never actually been wired up since Phase 0 (directives existed, but no PostCSS/Tailwind config did) — every earlier build had silently shipped zero working styles.

---

## Phase 2 — Scoring Engine — 2026-07-07

`ADR 0006`–`0010`

### Added

- Impact, effort, and ecosystem-value scorers; composite formula (`impact × 0.60 + ecosystem_value × 0.40`, effort as a tie-break only); deterministic mission copy generation.

### Fixed

- `db.transaction()` had never actually worked on the `neon-http` driver — silently, since unit tests mocked it. Switched to `neon-serverless` for the ingestion writer.
- OSV's batch endpoint returns only `{id, modified}` per result — every advisory ingested until this fix showed `severity: unknown` and a placeholder summary. Added a second detail-fetch stage.

### Known limitation introduced here

- Two scoring inputs (`downstream_dependents`, `has_migration_guide`/`breaking_change_signals`) had no data source and were stubbed rather than fabricated, with the direct effect that every mission showed `confidence: "low"` from this point on. Partially resolved in Post-Phase-6 (`ADR 0029`).

---

## Phase 1 — Data Pipeline — 2026-07-02

No new ADRs.

### Added

- OSV and npm registry ingestion, `package.json` dependency parsing and tree resolution, daily ingestion cron in GitHub Actions.

---

## Phase 0 — Foundation — 2026-06-30

`ADR 0001`–`0005`

### Added

- Monorepo scaffold (`/app`, `/cli`, `/packages/core`, `/scripts`), CI pipeline (lint/typecheck/test), Neon Postgres schema with Drizzle ORM (`schema.ts` as source of truth), two GitHub OAuth apps (dev + prod).
