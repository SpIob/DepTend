# AGENTS.md — DepTend

This file orients any AI coding agent (Claude Code, Codex, Cursor, or similar) working in this
repository. It's a living document — if something here contradicts what you find in the actual
source, **the source wins**. See §1.

---

## 0. Before You Touch Anything

1. **Read the actual source, not the docs.** Phase-status docs, ADRs, and comments in this repo
   have drifted from reality multiple times (npm-only assumptions surviving a PyPI/Go rollout,
   an `ingest.yml` secret reference that stayed stale for a full phase, a README claiming
   features that were never built). Verify a claim against real code before acting on it or
   repeating it.
2. **Run the full verification gate (§6) before calling anything done.** Partial checks have
   repeatedly let real bugs through in this project's history — see §12.
3. **A new dependency, a new paid service, or a schema migration is a decision point, not a
   thing to resolve unilaterally.** Flag it and stop; don't implement around it.
4. **Don't "fix" a settled decision (§11) without a decision point being raised first.** Several
   things that look like bugs on first read (no `repos.ecosystem` column, `missions` with no
   unique constraint, every mission showing `confidence: "low"`) are deliberate.
5. **Deliver drop-in-ready, complete files** — matching this repo's existing conventions, not
   partial diffs described in prose.

---

## 1. What This Project Is

DepTend (`github.com/SpIob/DepTend`, live at **https://deptend.vercel.app**) is a free, public,
solo-developer web dashboard that scans public GitHub repos' dependencies against the OSV
vulnerability database and turns the result into a ranked, fully-explainable list of maintenance
"missions" — each scored by vulnerability severity, ecosystem impact, and fix effort. Anyone can
browse the mission board; a logged-in GitHub user can submit a repo or claim a mission.

**Non-negotiable constraints — apply always:**

- **Zero budget.** Every service/library/tool must be free at the tier this project actually
  uses. Flag anything requiring a credit card, even on a free tier, before adopting it.
- **Solo developer (Mico).** No architecture, workflow, or ops burden that assumes a team.
- **Transparency-first.** No black-box scoring. Every mission shown to a user must expose its
  advisory source, its scoring inputs and weights, and a plain-language recommended action, one
  click away. Low confidence is surfaced, never hidden.
- **Opt-in only.** Public repo data only; no private repos, no scraped user data beyond what
  GitHub OAuth returns; repos are never added automatically.

---

## 2. Current State (high-level)

- Ecosystems supported: **npm, PyPI, and Go** (npm since Phase 1, PyPI since Phase 6, Go added
  in a later, undocumented-in-phase-notes pass — confirm `detectEcosystem`'s current probe order
  directly in `packages/core/src/ingestor/detect.ts`).
- Repo cap: `NEXT_PUBLIC_MAX_REPOS=150` (raised from 3→10→150 across Phases 5 and pre-launch
  prep). Set in Vercel env, `.env.local`, `app/src/app/api/repos/route.ts`'s fallback, and
  `app/src/app/page.tsx`'s fallback — **all four**, if you ever change it again.
- `/missions` is server-filtered, -sorted, and -paginated via core's
  `getBoardMissionsWithScoresPage` (`ADR 0031`) — SQL ordering mirrors `rankMissions()`; if
  scoring/ranking keys ever change, both sides must move together. Per-repo boards still use
  the fully client-side `MissionBoard` component.
- All six mutating API routes have Vitest route-level suites (`*.route.test.ts` colocated with
  each `route.ts`; run via app's `vitest.config.ts`, which provides the `@/` alias).
- In-memory (`Map`-based) rate limiting is in place on previously-unthrottled mutating endpoints.
- `CHANGELOG.md` exists at repo root — phase/date-based headers, not semver
  (`package.json.version` deliberately stays `0.0.1`).
- ADRs currently run through **0032** (downstream dependents; all Accepted).
  **Check `docs/adr/` for the real current max before assigning a new ADR number.**
- See §14 for the current known-issues list.

---

## 3. Repository Layout

```
DepTend/
├── .github/workflows/
│   ├── ci.yml                 # lint · typecheck · test, on PR + push
│   └── ingest.yml             # daily cron + on-demand workflow_dispatch ingestion
│
├── app/                        # Next.js 15 frontend + API routes
│   └── src/
│       ├── app/                  # pages, layout, error boundaries (error/global-error/not-found),
│       │                         # api/auth, api/repos (+[id]/bookmark|unbookmark|withdraw),
│       │                         # api/missions/[id]/claim|unclaim — each mutating route has a
│       │                         # colocated *.route.test.ts
│       ├── components/            # mission-board (client, per-repo), paginated-mission-board
│       │                         # (/missions, ADR 0031), mission-filter-bar, mission-card,
│       │                         # submit-repo-form, bookmark-toggle, withdraw-button,
│       │                         # auth-status, providers
│       ├── lib/                   # db.ts, auth.ts, github-dispatch.ts, rate-limit.ts(+test),
│       │                         # mission-board-query.ts, queries/missions.ts
│
│   └── vitest.config.ts          # provides the @/ alias for the route-level tests
│
├── cli/                         # @deptend/cli — npx-runnable, entirely in-memory, no DB writes
│   └── src/                       # index.ts, analyze.ts, build-rows.ts, output.ts, types.ts
│                                 # (feature-complete since Phase 4; NOT yet published to npm registry)
│
├── packages/core/                # @deptend/core — shared analysis engine, ESM, built to dist/
│   └── src/
│       ├── db/                     # schema.ts (SOLE SOURCE OF TRUTH for row types), queries.ts,
│       │                          # repos.ts, missions.ts, json-types.ts, query-types.ts, migrations/
│       ├── ingestor/                # {npm,pypi}.ts + {npm,pypi}-parse.ts + local-{npm,pypi}.ts,
│       │                          # {npm,pypi}-registry.ts, github-meta.ts, osv.ts, writer.ts,
│       │                          # detect.ts, interface.ts — plus Go equivalents (confirm exact
│       │                          # filenames in source; not covered by the phase docs on hand)
│       └── scorer/                  # impact.ts, effort.ts, ecosystem-value.ts, mission-scorer.ts,
│                                  # mission-copy.ts, ranking.ts, writer.ts, interface.ts
│
├── scripts/
│   ├── ingest.js                 # real pipeline entry point (cron / manual / submit triggers)
│   └── package.json              # {"type":"module"} — scopes scripts/ to ESM without touching root
│
├── docs/
│   ├── adr/                       # one ADR per major decision, numbered sequentially — canonical
│   │                              # reference for any non-trivial decision
│   └── data-model/README.md       # entity reference — must track schema.ts (has drifted before)
│
├── CHANGELOG.md                  # dated/phase headers, entry added in the same PR as its ADR
└── README.md
```

**Hard architectural rule (ADR 0012):** all Drizzle query-building for `/app` lives in
`packages/core/src/db/`, never built directly in `/app`. This exists because ESLint's typed
linting degrades Drizzle's branded generics to `error` type when the same file is type-checked
against more than one tsconfig at once — it's a correctness fix, not a style preference. Don't
reintroduce `db.select()...` inline in an `/app` file.

---

## 4. Tech Stack

| Layer                    | Choice                                                                                                                                                                                                               | Notes                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend                 | Next.js 15 + Tailwind CSS                                                                                                                                                                                            | Vercel Hobby hosting                                                                                                                                                                                                |
| Backend                  | Next.js API routes (Node.js)                                                                                                                                                                                         | Same repo as frontend                                                                                                                                                                                               |
| Database                 | PostgreSQL, Neon free tier                                                                                                                                                                                           | AWS AP-Southeast-1, Postgres 18, `pgcrypto` extension, `set_updated_at()` triggers on all mutable tables                                                                                                            |
| ORM / migrations         | Drizzle ORM + Drizzle Kit                                                                                                                                                                                            | `schema.ts` is the sole row-type source (ADR 0011); `schema.sql` is a non-authoritative reference artifact only                                                                                                     |
| DB driver                | `neon-http` for `/app` reads (stateless, no transactions); `neon-serverless` (WebSocket) for `scripts/ingest.js` (needs `db.transaction()`)                                                                          | Don't mix these up — see §12                                                                                                                                                                                        |
| Auth                     | GitHub OAuth via next-auth v4, pinned `^4.24.14`                                                                                                                                                                     | Gates repo submission + mission claiming only; mission board itself needs no login. v5 was never released stably — don't "upgrade" to it                                                                            |
| Hosting                  | Vercel Hobby                                                                                                                                                                                                         | Auto-deploy on merge to `main`                                                                                                                                                                                      |
| CI/CD & cron             | GitHub Actions, free tier                                                                                                                                                                                            | Public repo → effectively unlimited minutes                                                                                                                                                                         |
| Package manager          | pnpm workspaces monorepo                                                                                                                                                                                             | `packageManager: pnpm@9.15.0`; `engines`: node `>=20.0.0`, pnpm `>=9.0.0`                                                                                                                                           |
| Node                     | `.nvmrc` pins v26 locally; CI runs Node 24                                                                                                                                                                           | Deliberate split — don't "fix" without checking why first                                                                                                                                                           |
| Language                 | TypeScript 5.x                                                                                                                                                                                                       | Required in `/app` and `/packages/core`; plain JS acceptable only in `/scripts`                                                                                                                                     |
| Testing                  | Vitest                                                                                                                                                                                                               | Not Jest — Jest's `--experimental-vm-modules` failed on CI's Node version                                                                                                                                           |
| Lint/format              | ESLint 9 flat config + typescript-eslint, Prettier 3 + `prettier-plugin-tailwindcss`                                                                                                                                 | Enforced via Husky + `lint-staged` pre-commit                                                                                                                                                                       |
| Runtime deps of note     | `semver@^7.8.5`, `@renovatebot/pep440@^5.0.0`, `smol-toml@^1.7.0`, plus whatever Go manifest-parsing library was adopted for the Go ingestor (confirm in `package.json` — not documented in the phase notes on hand) | `@renovatebot/pep440`'s own `package.json` declares `engines.pnpm >=10.0.0`, ahead of this project's pinned `9.15.0` — currently harmless since `engine-strict` isn't set, but would break if that's ever turned on |
| Drizzle-kit-only devDeps | `dotenv`, `postgres`                                                                                                                                                                                                 | Added solely so `drizzle-kit migrate` works from a bare CLI context — not app runtime deps                                                                                                                          |

---

## 5. Environment Variables

| Variable                            | Used by             | Notes                                                                                                                                                                                                    |
| ----------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                      | App, Actions        | Pooled Neon connection (PgBouncer)                                                                                                                                                                       |
| `DATABASE_URL_UNPOOLED`             | `psql`, Drizzle Kit | Direct connection — required for DDL; PgBouncer doesn't support all of it                                                                                                                                |
| `GH_CLIENT_ID` / `GH_CLIENT_SECRET` | App, Actions        | Two OAuth apps (dev `localhost:3000` + prod). Named `GH_*` not `GITHUB_*` — **GitHub blocks the `GITHUB_` prefix on user-defined Actions secrets**                                                       |
| `NEXTAUTH_SECRET`                   | App                 | Random 32-byte secret                                                                                                                                                                                    |
| `NEXTAUTH_URL`                      | App                 | Note: next-auth v4 on Vercel actually builds the OAuth `redirect_uri` from the request's `Host` header, **not** this var — see §12                                                                       |
| `NEXT_PUBLIC_MAX_REPOS`             | App                 | Currently `150` — update all four locations listed in §2 together                                                                                                                                        |
| `GH_DISPATCH_TOKEN`                 | App, Actions        | Fine-grained PAT, `actions:write` — powers on-demand `workflow_dispatch` ingestion                                                                                                                       |
| `GH_REPO`                           | App                 | `"owner/name"` for this repo's own dispatch calls                                                                                                                                                        |
| `GITHUB_TOKEN`                      | Actions             | Auto-injected by Actions (5,000 req/hr authenticated vs. 60 unauthenticated). **Flagged as currently absent in production** — verify and set before relying on production ingestion rate limits          |
| `LIBRARIES_IO_API_KEY`              | Actions             | Free-tier libraries.io key (account signup, no credit card) — powers the `downstream_dependents` prefetch (ADR 0032). Absent ⇒ missions keep the flag set; present ⇒ 60 req/min budget paced client-side |

---

## 6. Standard Verification Gate

Run this, in this order, before considering any change complete. This sequence is this
project's own standing discipline across every phase — don't skip steps to save time.

1. **`typecheck`** — all workspaces. The root `typecheck` script also runs the
   `typecheck:tests` passes for `packages/core` and `cli`, so test files are covered here too.
2. **`test`** — Vitest, all workspaces.
3. **`build`** — a full Next.js production build. Ideally from a clean state
   (`rm -rf` every `dist`/`.next` first) — stale build output has masked real regressions before.
4. **`lint`** with `--max-warnings 0` — warnings are treated as build-breaking here. Explicit
   return types on mocks and no unused `async` are enforced this way.
5. **`format:check`** — Prettier, at minimum on touched files.
6. **`tsc --noEmit --project <package>/tsconfig.eslint.json`** for both `packages/core` and
   `cli` — wired into `ci.yml` as its own step as of the ADR 0031 pass (belt-and-braces since
   the root `typecheck` now includes it, but kept in CI so the check can't silently fall out).

**Confirm exact script names against the real `package.json` files** if any of the above don't
match what's actually configured — the names above reflect how this project consistently refers
to these checks, not a guarantee of literal script names.

**A meta-lesson worth internalizing:** across this project's history, real bugs have repeatedly
survived all six checks and only surfaced when something touched real infrastructure — a live
Neon database, the real OSV API, an actual GitHub Actions run, a real Vercel deploy, a real
`git commit`. Mocks that don't match the real contract are the recurring root cause (see §12).
Where practical, validate a new integration against real infrastructure at least once, not just
mocks — and if you can't (e.g. sandboxed network egress doesn't reach an external API), say so
explicitly rather than silently treating mock coverage as equivalent.

---

## 7. Code Conventions

- **Exhaustive switches, no silent defaults.** This codebase uses flat string-literal
  discriminated unions for outcome types, with exhaustive `switch` statements and explicitly
  documented unreachable cases — not `default` fallbacks. Match this shape in new code
  (`WithdrawRepoOutcome`, `statusToOutcome()` are recent examples of the pattern).
- **DB write pattern for solo-dev, no-transaction-needed writes:** a guarded single-statement
  `UPDATE`/`INSERT` (`WHERE` clause doing the guarding), input shape validated before the query
  reaches Postgres, and an outcome-typed return value — not a raw boolean. Used by
  `submitRepo()`, `claimMission()`/`unclaimMission()`, and the repo-withdrawal path. Reuse this
  template for new mutating writes rather than reaching for a transaction or a new migration by
  default.
- **No dependency without a documented reason** (ADR or PR description). Prefer the standard
  library or one well-maintained package over several micro-packages. Vet license + zero-budget
  compliance before adopting anything (as was done for `semver`, `@renovatebot/pep440`,
  `smol-toml`).
- TypeScript required in `/app` and `/packages/core`; plain JS acceptable only in `/scripts`.

---

## 8. Database & ORM Rules

- `packages/core/src/db/schema.ts` is the **single source of truth** for all table/row types.
  `schema.sql` is a non-authoritative reference artifact only — never edit it expecting it to
  matter.
- `neon-http` (used by `/app`) **cannot run `db.transaction()`** at all — this is documented,
  long-standing driver behavior, not a bug. Anything needing a transaction (the ingestion write
  path) uses `neon-serverless` (WebSocket) instead.
- `onConflictDoUpdate()` does not return the `id` of rows that already existed pre-upsert — only
  newly inserted rows. Re-`SELECT` inside the same transaction if you need existing IDs.
- Drizzle table objects do **not** expose a `table._.name` property — use `getTableName()` from
  `drizzle-orm` for table-name introspection.
- `missions` has **no unique constraint** — writes there are manual SELECT-then-INSERT/UPDATE,
  not `ON CONFLICT`. This is a deliberate trade-off to avoid an early migration, not an oversight
  waiting to be "fixed."
- There is **no `repos.ecosystem` column.** Which ecosystem a repo is gets decided fresh on every
  ingestion run by `detectEcosystem` (ordered probing), not stored as a static repo-level fact.
  `dependencies.ecosystem` / `advisories.ecosystem` are the per-row source of truth.
- Composite mission score: `impact × 0.60 + ecosystem_value × 0.40`. `effort_label` is a
  categorical tie-breaker only — never a numeric multiplier.
- Ranking tie-breaks must use genuinely per-row, immutable data. `created_at` looked safe but
  wasn't — Postgres' `now()` is fixed for a transaction's lifetime, and a whole ingestion run
  writes in one transaction, so missions created together never actually differ on it. The fix in
  place ties on the underlying advisory's own `published_at`, with `osv_id` as an absolute
  fallback. Composite-score comparisons are tier-bucketed (fixed-width buckets), not fuzzy
  pairwise, to keep "tied" a real transitive equivalence class — don't reintroduce a pairwise
  comparator without re-deriving why that failed before.

---

## 9. Testing Conventions

- Vitest, not Jest, across all workspaces.
- Every scoring algorithm (`impact`, `effort`, `ecosystem-value`) and every ingestor module needs
  unit test coverage before it ships to production.
- **Mocks must match the real contract.** Multiple real bugs in this project's history passed
  dozens of green mocked tests while being broken against real infrastructure — e.g. a mocked
  `db.transaction()` that never actually got exercised by the real (unsupported) driver, and a
  mocked OSV response that returned a full record when the real endpoint returns only
  `{id, modified}`. When mocking an external contract, verify the shape against real
  documentation or a real response at least once.
- `/app` has route-level Vitest suites for all six mutating API endpoints (colocated
  `*.route.test.ts`, run via `app/vitest.config.ts` which provides the `@/` alias). They mock
  core's write functions at the exact module boundary `/app` consumes, use the real rate
  limiter for 429 cases, and keep validators (`isValidUuid`, `parseGithubUrl`) real via
  `importOriginal`. UI components, server pages, and auth/dispatch glue remain verified only
  by manual/live testing — don't assume coverage exists there just because it exists elsewhere.

---

## 10. ADR & Changelog Process

- Every significant architectural decision gets its own ADR in `docs/adr/`, numbered
  sequentially. **Check the actual current max ADR number in the directory before assigning a
  new one** — don't trust a phase-status doc's index, which can be stale.
- New ADRs start `Proposed`; flipping to `Accepted` happens only after live verification (not
  merely passing the standard checks) — and this flip has repeatedly been left as trailing
  housekeeping across phases. Don't let a new ADR sit in `Proposed` indefinitely; flag it if it's
  been verified but not flipped.
- **Changelog entries are added in the same commit/PR as the ADR that motivates them** — never
  backfilled later. `CHANGELOG.md` uses dated/phase-based headers, not semver — don't bump
  `package.json`'s version as part of a changelog entry; it deliberately stays `0.0.1`.
- Cross-reference the ADR number in code comments and `docs/data-model/README.md` where
  relevant, and update `docs/data-model/README.md` in the same pass as any schema change — it
  has drifted before (it once referenced `schema.sql` for an entire phase after `schema.ts`
  became authoritative).

---

## 11. Settled Decisions — Don't Re-litigate Without a Real Reason

- **`deptend.vercel.app` is the project's permanent domain**, not a placeholder (ADR 0015).
  `deptend.dev` registration is deferred indefinitely — a small but real recurring cost against
  the zero-budget constraint. Don't suggest registering it without Mico raising it first.
- **No `repos.ecosystem` column** — see §8. This is intentional, not a missing feature.
- **`missions` has no unique constraint** — see §8. Don't propose a migration to "fix" this
  without flagging it as a decision point first.
- **Mission `confidence` is computed from real signals as of ADR 0029 + ADR 0032** — `breaking_change_signals`
  come from GitHub Releases data, and `downstream_dependents` comes from libraries.io (one paced
  call per analyzed repo per run; free-tier key required — absent key ⇒ flag stays set). A mission
  with all resolvable inputs reaches `"medium"` today; `"high"` additionally requires lock-file
  parsing to land (`resolved_version` is still always null). Note: pre-ADR-0032 docs (this file and
  CHANGELOG included) overclaimed that ADR 0029 alone enabled `"medium"` — it didn't, because both
  structural flags were always set until 0032.
- **Lock file parsing remains fully deferred** project-wide (`package.json`/manifest-only
  analysis). Don't start implementing lock-file resolution without an explicit go-ahead.
- **The npm-side `inferSemverBump()` reports `"major"` for upper-bound-only ranges** (via an
  implied `0.0.0` floor), while the PyPI-side `inferPep440Bump()` correctly returns `"unknown"`
  for the equivalent case. This inconsistency was found and deliberately left as-is — it's a
  known, documented gap, not an oversight to silently harmonize.
- **Repo cap is just an env var** (`NEXT_PUBLIC_MAX_REPOS`) — raise it freely when justified by
  real usage/storage data, but update all four locations noted in §2 together, and don't treat
  the number itself as sacred.

---

## 12. Learned Pitfalls (read before touching these areas)

**Database / Drizzle**

- `neon-http` cannot run `db.transaction()` at all — use `neon-serverless` for anything
  transactional (§8).
- `onConflictDoUpdate()` doesn't return pre-existing row IDs — re-`SELECT` if you need them.
- Drizzle tables don't expose `._.name` — use `getTableName()`.
- `pnpm typecheck` excludes test files by tsconfig scope — a required-field addition to a shared
  type won't necessarily surface as a compile error in test files. Run the `tsconfig.eslint.json`
  check (§6, step 6) to catch this class of bug.

**OSV / ecosystem data**

- OSV's `POST /v1/querybatch` returns only `{id, modified}` — **never** severity, affected
  ranges, or a summary. Full records require a per-ID `GET /v1/vulns/{id}` detail fetch.
- OSV's affected-range shape is ecosystem-dependent: `SEMVER`-type for npm, `ECOSYSTEM`-type for
  PyPI. **Confirm the shape for any new ecosystem (e.g. Go) rather than assuming `SEMVER`** — a
  wrong assumption here fails silently (empty ranges, `null` fixed version, no error at all).

**Build & tooling**

- ESLint typed-linting must stay scoped **per workspace package**, not one shared `project`
  array across all tsconfigs — checking the same file against multiple tsconfigs at once
  silently degrades Drizzle's branded generics to `error` type.
- `packages/core` must be built (`dist/`) before any consumer (`app`, `cli`, `scripts`) can use
  it. This has needed three independent fixes across three environments historically: a root
  `typecheck` script that builds core first, `predev`/`prebuild` hooks in `app/package.json`, and
  a root-level `postinstall` hook for Vercel specifically — Vercel's framework-preset build can
  bypass `package.json`'s `build`-script lifecycle entirely. `postinstall` (tied to
  `pnpm install`, which every platform always runs) is the more robust of these — prefer it for
  any new cross-environment build-ordering fix.
- `GITHUB_` is a blocked prefix for user-defined GitHub Actions secrets — hence `GH_CLIENT_ID`
  rather than `GITHUB_CLIENT_ID`.
- `workflow_dispatch` input schema changes must be **pushed to `main`** before testing a dispatch
  call against them — GitHub validates against what's committed on its own servers, not local
  files.
- `drizzle-kit migrate` can hang indefinitely against the WebSocket-based Neon driver in a bare
  CLI context (a known upstream interaction, not a bug in this codebase) — the `postgres`
  devDependency and loading `.env.local` via `dotenv` in `drizzle.config.ts` are the working
  fixes already in place. Don't remove either while debugging something else.
- Route modules can get evaluated at Vercel build time even for pages marked `force-dynamic` —
  use a lazy DB singleton (a `getDb()` function), not a top-level `const`, to avoid a build-time
  throw when an env var isn't set yet.

**Auth**

- next-auth v4 on Vercel builds the OAuth `redirect_uri` from the request's `Host` header, not
  `NEXTAUTH_URL` — this is intentional upstream behavior (it's what lets preview deployments
  round-trip correctly), but it means sign-in only works when tested from the exact registered
  callback domain, typed directly into the address bar.

---

## 13. Current Known Issues (most recent audit)

These are known and tracked — don't rediscover them as if new, and don't silently patch them
without confirming scope with Mico first (some may already be in progress). Refreshed
2026-08-22 against actual source:

- The 51MB demo GIF is gone from HEAD (removed in the CHANGELOG commit) but **still present in
  git history** — rewriting history has implications for existing clones/forks; treat as a
  decision point, not a quick fix.
- `GITHUB_TOKEN` is absent in production (Vercel) — the submission manifest pre-check therefore
  runs unauthenticated, sharing one global 60 req/hr GitHub budget across all traffic. Set it
  to get the authenticated rate limit.
- `getReposWithMissionSummary()`'s distinct-ecosystem scan reads all of `dependencies` with no
  index to lean on (`queries.ts`). Bounded in practice by real data volume, not by any cap — a
  `dependencies(repo_id, ecosystem)` index migration would close it properly. Flagged as a
  decision point during the ADR 0031 pass; deferred at current scale.
- ~~ADRs 0030 (repo submission safeguards) and 0031 (board pagination) stuck in `Proposed`~~ —
  both flipped to Accepted in the same commit as ADR 0032, after their live verification passes.
- `awesome-nodejs` / `awesome-python` list submissions are blocked pending star/age thresholds;
  `awesome-go` was dropped as a structural mismatch (DepTend consumes Go dependency data rather
  than being a Go package itself).

Resolved since the last audit (kept here so nobody re-litigates them):

- ~~Muddled HTTP status codes in the manifest pre-check route~~ — fixed and documented in ADR
  0030's correction note (not_found → 404, transient reasons stay 503).
- ~~Unbounded `/missions` DB query~~ — fixed by ADR 0031 (server-side filters + LIMIT/OFFSET;
  count helpers moved to `count(*)`).
- ~~`docs/data-model/README.md` missing `repo_bookmarks`~~ — table section and schema-changelog
  row added.
- ~~Near-zero test coverage on mutating `/app` API routes~~ — all six routes now have
  colocated route-level suites (see §9).
- ~~`ingest.yml` referencing `secrets.GH_INGEST_TOKEN`~~ — confirmed fixed: it uses the
  auto-injected `${{ github.token }}`.

---

## 14. Collaborating with Mico

- Confirms task completion with short, single-word prompts ("Continue," "Proceed") and expects
  concise chat responses paired with thorough, complete implementation work — don't pad the
  conversational reply, but don't shortcut the actual deliverable either.
- Prefers unresolved decisions labeled explicitly as **blockers**, not silently resolved by
  assumption. Ask a targeted clarifying question before a substantial deliverable if something
  is genuinely ambiguous.
- Wants deliverables **drop-in ready**: matching existing conventions, verified against the full
  gate in §6, delivered as complete files (not partial diffs) when multiple files need to change
  together — batch them as a set.
- ADR numbers are the canonical reference for any decision — cite them in code comments, PR
  descriptions, and doc updates rather than re-describing the reasoning inline.

---

_This file should be kept current as the project evolves. If you make a change that contradicts
something written here — a settled decision that gets revisited, a pitfall that gets fixed for
good, a new recurring gotcha — update this file in the same PR._
