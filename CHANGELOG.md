# Changelog

All notable changes to DepTend, condensed to one entry per phase.

**Conventions used here:**

- No semver; `package.json`'s version has stayed `0.0.1` throughout; a fake version number per entry would misrepresent a project that's never cut a release. Entries are dated by phase-completion date instead.
- This is a **condensed** summary; major, user- or developer-facing changes only. For full detail, alternatives considered, and retroactive fixes, see the corresponding ADR(s) linked in each entry, or the phase status docs for Phases 0–6.
- Ordered newest first.

---

## [Unreleased]

**Data-handling correctness + dedup pass (2026-08-29)**

Survey-driven cleanup of the read layer and several write paths. Every
finding here was flagged as either a real data-correctness risk or a
correctness trap waiting on the next schema change. The cluster ships
as one commit because most of the changes touch the same files (the
directory-base query, the cached-read wrapper, the route body
parsers); splitting them per-PR would have required unsafe hunk
splits. No schema migration. No public-API change.

### Fixed

- `getRepoDirectoryBase` and `getRepoDirectoryBaseByOrg` were two
  functions, and the latter correctly applied the org scope to all
  three of its parallel sub-queries while the former applied none.
  Anyone reusing the un-scoped variant for a non-global call would
  have gotten a wrong `ecosystems`/`missionCounts` set. Merged into
  one function accepting an optional `{ orgLogin, userLogin }`. The
  three parallel sub-queries now correctly receive the org scope on
  every branch.
- `isBookmarked` and `isSubscribed` overlay logic was split between
  core and /app, with the /app side missing the subscription overlay
  entirely. The org page's notification toggle was silently hidden
  because `isSubscribed` was undefined there, and a bookmark made on
  the directory page showed stale "not bookmarked" on a re-visit to
  the org page. Moved both flags into core's `getRepoDirectoryBase`
  so the overlay is owned by one place; the per-user path bypasses
  the cache (per-user overlay must never share a cache key with
  another user); the anonymous path keeps caching under the "repos"
  tag.
- `getRepoBoardPage`'s `total` was counting across all repos, not
  just the scoped one — the row query's WHERE included the
  `repoScope`, but the tally's `total` FILTER didn't. Fixed as part
  of the tally-extraction below; a per-repo page that filtered to
  one repo would have shown the count of every matching mission
  board-wide.

### Added

- `app/src/lib/queries/cached-read.ts` — single `cachedRead(keyParts,
tag, read)` and `READ_CACHE_SECONDS` constant for the whole read
  layer. Before this, both `queries/missions.ts` and
  `queries/organizations.ts` reimplemented `cachedRead` locally with
  slightly different tag unions; a new read added to either file
  had to be carefully wired into the right tag. The module's header
  documents the full cache-tag invalidation matrix (which route
  revalidates which tag) so the next contributor doesn't have to
  reverse-engineer it.
- `app/src/lib/body-parse.ts` — `parseOptionalJsonBody` and
  `parseRequiredJsonBody` helpers. Three different inline body-parse
  policies existed (repos returns 400 on bad JSON, dismiss silently
  treats bad JSON as "no body", subscribe silently treats bad JSON
  as "no eventTypes"). One helper per intent; the three routes now
  use one of the two clearly-named helpers.

### Changed

- `getBoardMissionsWithScoresPage` and `getRepoBoardPage` now share a
  `buildBoardTallySelect` + `runBoardTally` pair. The two were
  duplicated almost verbatim (~80 lines each) since `getRepoBoardPage`
  was added (ADR 0041); the dedup also exposed the per-repo `total`
  bug above.
- `packages/core/src/db/organizations.ts`,
  `organization-members.ts`, and `notifications/subscriptions.ts`
  no longer re-declare `ReadonlyDb`; they import from
  `db/queries.ts` (the canonical export). The redeclarations were
  structurally identical but nominally different — exactly the type
  identity issue that motivated ADR 0012's "all Drizzle query
  building in /packages/core" rule.

### Removed

- `packages/core/src/db/repos.ts::getReposByOrg` — unused, and a
  same-named but different-shape function (`Repo[]` vs
  `RepoWithMissionSummary[]`) lived in `db/queries.ts` and was the
  one callers actually used. The /app wrapper was already aliased.

### Tests

- `packages/core/src/db/queries.test.ts` — new
  `getRepoDirectoryBase` describe block with four cases (the
  bookmark+subscription overlay, the signed-out skip, the org scope
  on all three sub-queries, and the unknown-org-empty-list path).
- `app/src/lib/queries/missions.test.ts` — new test that the
  signed-in path bypasses the cache (per-user overlay must never
  share a cache key with another user).

**Security hardening pass (security audit 2026-08-29)**

### Added

- `app/src/lib/login.ts::isValidLogin` — GitHub login validation at the JWT boundary.
  Mirrors GitHub's own account-name spec. A non-conforming login leaves the
  session with `login: undefined`, so every downstream consumer (the rate-limit
  Map, `repos.submitted_by`, `missions.claimed_by`, `repo_bookmarks.user_login`,
  `notification_subscriptions.user_login`) naturally returns 401 instead of
  accepting a malformed identifier. Validated once at sign-in time means a
  malformed value can never reach the shared Map's keys.
- `app/src/lib/sign-in.ts::signInWithGitHub` — single helper wrapping
  next-auth's `signIn("github")` and pinning `callbackUrl` to
  `window.location.origin + window.location.pathname`. Replaces five direct
  `signIn("github")` call sites (`auth-status`, `bookmark-toggle`,
  `mission-card`, `notification-toggle`, `submit-repo-form`) so a
  `?callbackUrl=https://attacker/` query string on the OAuth start URL can't
  redirect a freshly-signed-in user off-domain.
- `Referrer-Policy: no-referrer` and an explicit `Permissions-Policy` denying
  `camera`, `microphone`, `geolocation`, `interest-cohort`, `payment`, `usb` set
  in the response headers by `app/src/middleware.ts`. The page uses none of
  these features; outbound "View on GitHub" links no longer leak per-user URL
  state to the third-party host; a future XSS-via-CSP-bypass would have fewer
  browser capabilities to weaponize.
- `app/src/app/api/repos/[id]/notifications/subscribe/route.test.ts` and
  `…/unsubscribe/route.test.ts` — both routes had no colocated test file
  before this pass; the seven other mutating routes did. The PR fills that gap
  and pins the new M3 `eventTypes` allow-list contract.

### Changed

- `app/src/lib/auth.ts` now passes `NEXTAUTH_SECRET` explicitly via
  `authOptions.secret`. A deploy missing the env var fails loudly at request
  time, not at JWT-decode time. CI / test environments set a known dev value.
- `app/src/lib/auth.ts`'s `jwt` callback now validates `user.login` against
  GitHub's account-name spec via `isValidLogin` before stamping it onto the
  token. A non-conforming value leaves `token.login` undefined, which the
  `session` callback propagates as `session.user.login = undefined`.
- `app/src/app/api/repos/[id]/notifications/subscribe/route.ts` now
  allow-lists the `eventTypes` array against
  `["new_mission", "claimed", "resolved", "reopened"]` (the set
  `github-issues.ts` already typechecks against) and caps the array at 4
  entries. Anything else is rejected with 400 before reaching the DB. The
  column default and the route's no-body success path are unchanged.
- `app/src/app/error.tsx` and the two notifications routes now log
  `err instanceof Error ? err.message : err` instead of the full Error
  object, matching the discipline already in use in
  `app/src/lib/rate-limit.ts`. Drizzle sometimes populates thrown errors
  with bound query parameters; the prior shape could echo user-controlled
  values into Vercel function logs.

### Removed

- None.

**Parallel OSV + registry fetches in `scripts/ingest.js`**

### Changed

- The per-repo ingestion script now issues the OSV advisory fetch and the per-ecosystem registry metadata fetch concurrently via `Promise.all` instead of serially. The two fetches only need the parsed dependency list and the resolved ecosystem (both already in hand after `detectEcosystem`), they're independent endpoints (`api.osv.dev` vs. the per-ecosystem metadata API), and both are stateless for the duration of a single call. Roughly halves the per-repo ingestion wall time on a hot cron run. The `writer.write()` and `missionWriter.generateMissionsForRepo()` call sites, the result shapes, and the warning-logging semantics are unchanged. No schema migration, no `/app` change, no new ADR (script-level change, per the discussion in the planning pass).

**Bulk mission writes inside the scorer transaction (ADR 0043)**

### Changed

- `MissionWriter.generateMissionsForRepo()`'s in-transaction write phase now issues a constant number of round-trips (5, regardless of candidate count) instead of 2N — one bulk `INSERT missions`, one `UPDATE missions … FROM (VALUES …)`, one bulk `INSERT mission_scores … ON CONFLICT (mission_id) DO UPDATE`, plus the unchanged existing-mission lookup and auto-resolution close pass. The pre-write classification pass now uses a pre-built `Map<id, Dependency>` for O(1) lookups, replacing the O(N²) `allDeps.find()` pattern. For a 200-mission re-ingestion, the write phase is ~40× fewer DB statements and ~2–4 s faster per repo; the per-repo daily cron run reclaims 50–750 s of wall time depending on dataset shape. Mission output, score values, status transitions, the "dismissed rows keep human state" invariant (ADR 0008 §3), and the "previously auto-resolved mission whose pair came back is reopened" rule are all preserved exactly. The `MissionWriter` public API and `GenerateMissionsOutput` shape are unchanged. No schema migration, no `/app` change. Live-verified against the dev Neon database before flip; ADR 0043 will go from Proposed → Accepted in the same commit as the deploy confirmation per the standing rule.

**Parallel ecosystem detection (ADR 0041)**

### Changed

- `detectEcosystem()` now probes every ingestor in parallel via `Promise.all` + `AbortController`, with caller-list order as the explicit tie-breaker. A Go-only repo no longer waits for the npm + pypi probes to fully fail before Go is tried; the per-repo cron and the user-facing submission manifest pre-check each save up to 4–6 wasted HTTP round-trips per non-npm-first repo. The npm-first / pypi-second / go-third priority contract (ADR 0022 / 0024) is preserved exactly — a lower-priority probe never wins on wall-clock latency alone. In-flight loser probes are aborted at the OS level as soon as a higher-priority probe claims the win, instead of completing and being discarded. The all-fail path (no probe resolves) is unchanged at the public boundary: every attempt's warnings are still combined in caller-list order. No schema migration, no `/app` change, no caller-source change.

---

**Mission board unification + UI quick wins + cached-read revival audit (ADR 0042)**

### Changed

- Per-repo mission board (`/repo/[owner]/[name]`) is now served by the same `PaginatedMissionBoard` the board-wide `/missions` listing uses, via a new `getRepoBoardPage(repoId, filters)` query in `packages/core/src/db/queries.ts` (sibling of `getBoardMissionsWithScoresPage`; same `BoardPage` shape, same `count(*) FILTER (...)` facet aggregate, plus a `WHERE missions.repo_id = $1`). The older fully client-side `MissionBoard` / `MissionFilterBar` components are removed. One filter codepath to maintain instead of two; per-repo page is now on the same cached, server-side filter path `/missions` already is. `MissionCard`, `MissionSearchInput`, the URL query shape (`mission-board-query.ts`), and the claim/unclaim optimistic-patch path are all unchanged; the per-repo page's `← All repos` link, bookmark toggle, and "View on GitHub" header all stay the same. `PaginatedMissionBoard` gains a `showGroupByRepo` prop (default `true`; per-repo page passes `false`) so the now-redundant "Group by repo" toggle doesn't reappear on a board where every row is one repo.
- Error boundaries: the route-segment `error.tsx` CTA now reads "Browse repos" (was "Back to repos"), matching the canonical copy on the directory and 404. Both `error.tsx` and `global-error.tsx` now show a `title="Include this if you report an issue"` tooltip on the optional `error.digest` line, so users pasting it into an issue remember to keep it.
- `app/src/components/notification-toggle.tsx`: the "Notify ✓" active state is now just "Notify" with `aria-pressed` as the source of truth for both screen readers and sighted users (mirrors `BookmarkToggle`'s pattern); the redundant `✓` glyph and its three-state screen-reader announcement are gone.
- `app/src/components/mission-card.tsx`: the composite score block now exposes `aria-label="Composite score X.X out of 10"` (the prior `title=` only reached mouse users); `FixedVersionTag`'s visible text changed from "→ {version}" to "Fix: {version}" so the visible content matches what screen readers hear (the prior `aria-label` + `aria-hidden` setup was the wrong anti-pattern).
- `packages/core/src/db/repos.ts`: exports `WITHDRAWABLE_INGESTION_STATUSES`; `withdraw-button.tsx` now imports it instead of mirroring the list. A new `ingestion_status` value added server-side will reach the UI automatically; previously a status list drift would silently leave the button shown for statuses that 409.
- Skip-to-content link: `error.tsx` and `global-error.tsx`'s `<main>` now carry `id="main"`, so the layout's skip link actually skips to content on those boundaries (`not-found.tsx` and the regular pages already had it).
- `app/src/app/page.tsx` (`/`): the "N skipped" disclosure, previously an inline `<details>` wedged into the auth-status flex row (where its popover floated over the auth button on narrow screens), is now a dedicated section below the directory grid with its own heading. The header strip is one coherent line again.

### Added

- `app/src/components/brand-mark.tsx`: the wordmark (accent square + "DepTend" in mono) is now a single component used by all four pages; was hand-copied four times with subtle class drift.
- `app/src/lib/search-params.ts`: `firstSearchParamValue` helper replaces the two `function firstValue` copies in `missions/page.tsx` and `repo/[owner]/[name]/page.tsx`.
- `app/next.config.ts`: `images.remotePatterns` now allowlists `avatars.githubusercontent.com` and `gravatar.com` so `next/image` can optimize the org avatar. The org page previously rendered a raw `<img>` with a no-op `bg-bg`; it's now `<Image>` with `width={32}`, `height={32}`, `loading="lazy"`, `decoding="async"`, and a real surface-color border.

### Fixed

- `app/src/app/page.tsx`: `NEXT_PUBLIC_MAX_REPOS` now has a `Number.isFinite` / `> 0` guard; a non-numeric env value (e.g. `NEXT_PUBLIC_MAX_REPOS=banana`) silently disabled the cap check before, since `count >= NaN` is always `false`.
- `app/src/components/mission-search.tsx`: the search clear `×` button was a 14×20 hit target; it's now centered flex with `px-2.5` padding (≥24×24 on both axes per WCAG 2.5.5).
- `app/src/app/loading.tsx`, `app/src/app/missions/loading.tsx`, `app/src/app/repo/[owner]/[name]/loading.tsx`: skeleton list keys are now stable (`"skeleton-0"`, `"mission-1"`, etc.) instead of `0, 1, 2, 3` — makes it obvious these are placeholders, not a list.

### Audit

- H6 read-only audit: every `unstable_cache` site uses the same `cachedRead()` wrapper in `app/src/lib/queries/{missions,organizations}.ts`; both wrappers apply `reviveDates` to `cached()`'s result, outside the serialization boundary, matching the ADR 0033 correction note. The new `getRepoBoardPage` (above) goes through `missions.ts`'s wrapper and inherits the same correct placement. No latent revival-inside-callback sites; no `unstable_cache` calls outside the two wrappers. No code change needed.

---

**Parallel ecosystem detection (ADR 0041)**

### Changed

- `detectEcosystem()` now probes every ingestor in parallel via `Promise.all` + `AbortController`, with caller-list order as the explicit tie-breaker. A Go-only repo no longer waits for the npm + pypi probes to fully fail before Go is tried; the per-repo cron and the user-facing submission manifest pre-check each save up to 4–6 wasted HTTP round-trips per non-npm-first repo. The npm-first / pypi-second / go-third priority contract (ADR 0022 / 0024) is preserved exactly — a lower-priority probe never wins on wall-clock latency alone. In-flight loser probes are aborted at the OS level as soon as a higher-priority probe claims the win, instead of completing and being discarded. The all-fail path (no probe resolves) is unchanged at the public boundary: every attempt's warnings are still combined in caller-list order. No schema migration, no `/app` change, no caller-source change.

**Migration bookkeeping recovery (ADR 0040)**

### Fixed

- `/repo/[owner]/[name]` (and every other page that selects from `repos`) was failing on production with the "Something went wrong" route-segment error boundary. The dev server threw `column "org_id" does not exist`; the same Neon error, just exposed locally. Root cause: commit `a539d8e` had added four migration `.sql` files (`0007_add_transitive_dep_type`, `0008_board_query_composite_indexes`, `0009_organizations`, `0010_notification_subscriptions`) without registering any of them in `packages/core/src/db/migrations/meta/_journal.json`. Drizzle's migrator reads the journal as the source of truth; orphan `.sql` files are ignored. `drizzle-kit migrate` completed with `[✓] migrations applied successfully!` and zero rows changed, on every environment. Consolidated the four hand-written files into a single auto-generated migration (`0007_foamy_chimera.sql`) registered in the journal, applied to dev and to production.

### Added

- `drizzle-kit check` step in CI: fails the build if `packages/core/src/db/schema.ts` drifts from the committed migrations. Catches the whole class of bug above (hand-written SQL files committed without journal entries, or schema.ts changed without a matching migration). No DB connection required.

### Changed

- `docs/data-model/README.md`: `repos.org_id` FK, new `organizations` / `organization_members` / `notification_subscriptions` tables, `transitive` value on `dep_type`, `advisories.epss_score` column, schema changelog row 0.1.8; all in the same pass as the schema change, per the standing rule.

---

**Security hardening pass II: origin validation, nonce CSP (staged), URL-encoding discipline (ADR 0037)**

### Added

- Origin validation on all eight mutating API routes: a shared `isSameOrigin()` gate rejects cross-origin POSTs with 403 before any other check; defense-in-depth on top of next-auth's `SameSite=Lax` cookie default, which had been the sole CSRF layer. Absent `Origin` stays allowed (non-browser clients can't be CSRF victims); hosts are compared scheme-insensitively via `x-forwarded-host`/`Host`. All eight colocated route suites now send same-origin Origin+Host and pin the cross-origin rejection.
- Nonce-based CSP middleware (`app/src/middleware.ts`), shipping **report-only** by design: per-request nonce, policy stamped onto App Router bootstrap scripts via request headers, emitted as `Content-Security-Policy-Report-Only` until the deployed site runs it clean; flipping `CSP_ENFORCED = true` is the entire rollout step. Replaces next.config's old `'unsafe-inline'` report-only policy; dev keeps `'unsafe-eval' 'unsafe-inline'`.
- `fetchWithRetry` gains `maxRetryAfterMs`: caps how long a server's `Retry-After` may delay the single retry. The submission pre-check passes 2 s, so a 403/429 carrying `Retry-After: 120` can no longer stall the submitter's POST for ~2 minutes against the pre-check's stated 10-second posture. Background ingestion keeps the unchanged 120 s default.
- `buildRawContentBase()` in core (`github-meta.ts`): percent-encodes each segment of raw.githubusercontent.com base URLs. A repo-controlled branch ref containing `%` (legal in git refnames) previously reached raw.githubusercontent.com unencoded and was decoded server-side into path structure (e.g. `x%2F..%2Fother` → `x/../other`), potentially attributing another path's manifest to the submitting repo. Used by both `manifest-check.ts` and `scripts/ingest.js`.

### Changed

- Go module-path validation rejects bare-dot segments (`.`/`..`): they were interpolated into proxy.golang.org URLs where path normalization silently resolved them to a different module than the go.mod line named. Domain-style single dots (`example.com`) unaffected.
- GitHub profile-page links in mission cards and the repo page encode owner/name segments (defense-in-depth; values are charset-validated at submission).
- Deprecated `X-XSS-Protection` header dropped; ADR 0036 (dependency hygiene) flipped Proposed → Accepted after live verification.
- CSP enforcement flipped on the same day it shipped: report-only phase verified clean on the deployed site (`/` and `/missions`, all inline scripts nonce-stamped, zero violations in a real browser), then `CSP_ENFORCED = true` and ADR 0037 → Accepted. Rollback is the one constant, documented in `app/src/middleware.ts`.

---

**Data-lifecycle pass: re-ingestion, dependency pruning, reachable mission outcomes**

### Added

- Stale re-ingestion: cron runs now also pick `complete` repos whose `last_ingested_at` is older than `REINGEST_STALE_DAYS` (default 7), oldest first and capped at `REINGEST_MAX_PER_RUN` per run (default 25) to pace the shared GitHub/libraries.io budgets; until now a repo was ingested exactly once and its board froze at first-run time. Fresh `pending`/`failed` repos always go first.
- Dependency pruning: a successfully-parsed manifest is now treated as the authoritative dependency set; rows for packages it no longer lists are deleted in the ingestion transaction (cascading their `dependency_advisories`; missions survive via SET NULL on `dependency_id`). A run that couldn't read the manifest never prunes, so a transport blip can't wipe a repo's last good state.
- Mission auto-resolution: after each repo's candidate loop, every open/claimed mission whose `(dependency_id, advisory_id)` pair produced no candidate is closed as `resolved` inside the same transaction; this makes "resolved" a reachable status and stops the board accumulating permanently-open missions for problems that are already gone. A previously auto-resolved mission whose pair comes back is reopened ("resolved" was pipeline state, not user state); dismissed keeps its human decision; claim fields survive as history. Reported via a new `resolved` count on `GenerateMissionsOutput`.
- Dismiss/undismiss: `POST /api/missions/[id]/dismiss` (open missions only, any signed-in user, optional bounded `reason` stored on `dismiss_reason`) and `/undismiss`; colocated route suites included, same mock-at-the-module-boundary discipline as the other six mutating routes. Mission cards grow a secondary Dismiss button next to Claim and a Restore affordance for dismissed missions.

### Fixed

- Repos deleted/renamed/privated on GitHub no longer retry every day forever: `fetchGitHubRepoMeta`'s structured `not_found` now marks the repo `skipped` (the writer's established terminal state, never re-picked by cron) instead of `failed`, and does not fail the run; one dead repo can't keep the daily job red with nothing actionable left.

### Changed

- `docs/data-model/README.md`: repos status lifecycle (staleness re-pick, terminal `skipped`), dependencies reconciliation note, and the missions status-lifecycle paragraph added in the same pass as the behavior.

### Security

- Security hygiene pass (ADR 0036): production dependency vulnerabilities reduced from 20 findings (1 critical / 9 high) to 1 known false positive; `next-auth` ≥4.24.15 and `next` ≥15.5.x via lockfile update, plus three pnpm overrides (`postcss`, `nanoid`, `sharp`) past the floors `next` itself pins. New weekly Dependabot config (npm + github-actions) and an advisory `pnpm audit --prod` step in CI. Both workflows now run least-privilege with explicit `permissions: contents: read`.

**Correctness pass: submission identity, board navigation races, dispatch visibility**

### Fixed

- Repo submissions stored raw parsed owner/name casing while ingestion always writes back GitHub's canonical casing (`ghMeta.full_name`); a case-mismatched URL forked into two rows for one real repo, the first stranded at `pending` and re-picked by every cron run forever, with case-sensitive 404s on direct `/repo/*` navigation. The route now dedups on and stores the canonical casing the manifest pre-check already fetches, and short-circuits exact-case re-submissions before any network call (saves the shared unauthenticated 60 req/hr budget).
- `/missions` filter/sort/clear/search navigations carried the stale `?page=N`: `buildHref`'s base always included the current page, landing users mid-results of their new filter instead of its top-ranked page (contradicting the comment above the code). Page now comes only from explicit pagination overrides.
- Debounced search could silently undo a filter click within its 300 ms window: the armed timer survived the chip's navigation (keyed on `search` alone), then fired a stale-closure URL without the just-clicked filter. Explicit navigations now cancel the pending commit (their href already carries the typed text), and the deferred commit builds its URL from the latest render so a group-by toggle landing mid-window isn't reverted either.
- `ingest.yml` had no `concurrency` guard; overlapping cron/dispatch runs both process the same pending repos, and with `missions` deliberately unconstrained, interleaved MissionWriter check-then-inserts could create duplicate missions nothing can ever dedupe. Now queued single-file (`cancel-in-progress: false`; killing a run between openRun/closeRun would strand rows at `"running"`).

### Changed

- The best-effort ingestion dispatch carries a hard 10 s deadline (a hung socket previously held the submitter's POST open until the platform kill timeout), and its failure reason is logged server-side; an expired `GH_DISPATCH_TOKEN` otherwise degrades every submission to next-daily-cron latency looking like nothing broke.
- Submission route tests extended: canonical-casing assertion on the created row, exact-case duplicate short-circuit before the pre-check, case-variant duplicate caught post-pre-check, and the dispatch-failure log line.

**Transport-hardening pass: deadlines, full retry coverage, ingest write-path round-trip cut**; `ADR 0035`

### Added

- `fetch-retry.test.ts`: direct unit suite for the shared transport policy; Retry-After parsing/capping, transient-status matrix, body-cancel hygiene, per-attempt deadline behavior, caller-cancellation semantics. Closes the gap where the load-bearing helper shipped with only indirect coverage.
- Per-attempt deadlines on every outbound ingestor fetch (`timeoutMs`, default 30 s via `AbortSignal.timeout`): a hung socket now surfaces as a retryable failure instead of stalling the run; the failure mode that left repos stuck at `ingestionStatus: "running"` forever, since `closeRun` only executes on completion.
- ADR 0035 + migration `0006`: `idx_missions_dependency_id`, serving MissionWriter's existence checks; production applies it together with pending migration `0005` in the next deploy window.

### Changed

- The shared retry policy is now actually shared: `github-meta.ts` (the rate-limit-sensitive call), all three registry fetchers, all three manifest fetchers including lock-file HEAD probes, and downstream-dependents.ts's page fetches route through `fetchWithRetry`. Previously only osv.ts and changelog-signals.ts did; downstream-dependents kept a hand-rolled 429-only retry where a network error mid-scan discarded the whole listing. Ingestion keeps the default backoff; interactive callers tune it down.
- `fetchGitHubRepoMeta` throws `GitHubMetaError` carrying a structured `kind` (`not_found | rate_limited`) with byte-identical messages; manifest-check.ts classifies failures structurally instead of matching message prefixes; wording tweaks can no longer silently degrade the submission pre-check's 404/429 mapping.
- MissionWriter does ONE bulk existence SELECT for all candidate pairs inside the transaction instead of one SELECT per candidate; N+1 round trips → 1, shortening how long each repo's Neon WebSocket transaction stays open (ADR 0035).
- changelog-signals.ts stops paginating when a short (<100 releases) page comes back; same guaranteed-empty-request elimination as downstream-dependents.ts.
- Dead code removed: `getOpenMissionsWithScores()` (superseded by ADR 0031's board query), `CompositeScoreResult`, `RepoWithIngestionStatus`; orphaned doc block over `getRepoEcosystems` untangled and `SkippedRepo.reason`'s npm-only comment updated for PyPI/Go.

**Robustness pass: two production-breaking read-path bugs, retry discipline, scoring fix**

### Fixed

- `/missions` served error-boundary skeletons in production from the day ADR 0031 deployed: its final ORDER BY tie-break was `COALESCE(advisories.osv_id, missions.id)`; text vs uuid, which Postgres rejects (`42804`). Every mocked test passed because the fake transport asserts SQL text and never executes it; the live pass finally caught it. Fixed with a `::text` cast (ADR 0031 correction note), plus a new `DATABASE_URL`-gated test block in `queries.test.ts` that executes all three board sort modes against real Postgres so this class of error fails locally instead of live.
- `/` crashed the same way for a different reason: ADR 0033's `reviveDates` ran _inside_ the `unstable_cache` callback, whose return value gets JSON-serialized before the caller sees it; so every served read carried `*At` ISO strings and `repo-card.tsx`'s `lastIngestedAt.toLocaleDateString()` threw. The revival was dead code on every path. Moved outside `cached()` (hits revive, misses pass through), pinned by regression tests with a serializing-cache fake (ADR 0033 correction note).
- OSV records carrying only a CVSS vector string (`CVSS:3.1/AV:N/...`, no bare numeric score) got `cvssScore: null` and severity derived without CVSS; most GHSA records look exactly like this. Vector strings now compute their base score per the CVSS v3.1/v2 specs (weights cross-checked against NVD-published scores for canonical vectors); both `cvss_score` and derived severity stop under-reading.
- A transient network error while probing ecosystems aborted detection instead of falling through to the next ingestor; one flaky request against raw.githubusercontent.com could skip an npm repo whose pyproject.toml would have resolved. Probe failures now convert to unresolved results carrying the error as a warning, matching the router's never-throw contract.

### Changed

- One shared transient-failure retry policy for outbound ingestor fetches (`fetch-retry.ts`): one retry after flat backoff, honoring capped Retry-After headers, covering 429/500/502/503/504 and network errors. Extracted from downstream-dependents.ts's discipline; osv.ts (batch + detail fetches) and changelog-signals.ts (releases pages) now follow it instead of failing instantly or not at all.
- changelog-signals.ts no longer stores a page-cap-truncated scan as checked data: hitting 5×100 releases without reaching the version floor now returns `source_available: false` (confidence flag stays set), discarding partial findings; same unavailable-beats-wrong rule as downstream-dependents.ts.
- `reviveDates()` guards with an exact ISO-timestamp regex before calling `new Date()`: a non-date `*At`-suffixed string (jsonb blobs can carry them) passes through instead of becoming an Invalid Date.
- ADRs: 0034 flipped to Accepted (index-only scan verified via `EXPLAIN` on dev); 0033 stays Proposed pending a post-deploy two-request check, correction note added; 0031 correction note documents the COALESCE bug above.

### Added

- `npm-parse.test.ts`: direct coverage of `parsePackageJsonContent` (name validation rules, section handling, lock-file warnings), closing the gap with its pypi-parse/go-parse siblings that npm.test.ts only covered indirectly through mocked fetches.

**Read-path performance pass**; `ADR 0033`, `ADR 0034`

### Added

- `vercel.json` pins Next.js functions to `sin1`, alongside Neon (AP-Southeast-1); the dashboard setting was already correct; now it can't drift.
- `/missions` loading skeleton, matching the existing `/` and `/repo/*` ones. Reverses this log's earlier "deliberately gets none" note below: in-board filter/search navigations run inside a transition and keep the page mounted (the "Updating…" path), so the skeleton only mounts on entry to the route; exactly where the blank screen was.

### Changed

- Mission list payloads dropped every advisory column no consumer renders; `raw_data` (the verbatim OSV record), `details`, `affected_versions`, and five more; via a narrow projection in the shared five-table join. `MissionWithScore.advisory` is now an `AdvisorySummary`; ranking keys (`published_at`, `osv_id`) and everything "Why this score?" renders are untouched. Both boards ship visibly smaller flight data per row.
- The board's total count and all three facet axes come out of one `count(*) FILTER (...)` statement instead of four parallel statements; one join scan per request instead of five over the same join. Facet semantics unchanged ("how many if I also picked this").
- Shared reads cached under two tags (`missions`, `repos`) with a 60-second TTL: claims/bookmarks/submissions/withdrawals revalidate their tags on success and stay instant; ingestion-driven changes (written by the external Actions cron) appear within 60 seconds. Pages stay `force-dynamic`. Dates are revived after cache hits; `unstable_cache` serializes them to strings.
- New index `idx_dependencies_repo_ecosystem` turns the homepage's full-table `SELECT DISTINCT repo_id, ecosystem FROM dependencies` into an index-only scan, closing the §13 known issue deferred since ADR 0031. Applied to dev; production gets it on the next deploy window's `drizzle-kit migrate`.
- Per-repo board filtering memoized: search haystacks build once per mission list, not once per keystroke render.

**Mission board focus fix, accessibility pass, security hardening, docs truth-check**

### Fixed

- `/missions` search no longer loses focus mid-typing: the board stopped remounting on every debounced search commit (it was keyed by its full URL), filter chips/clear/pagination became real buttons behind one shared transition; also fixing invalid `aria-pressed` on links; and an "Updating…" status shows while a filter/sort/search navigation runs.
- Screen readers now hear async outcomes: `role="status"` regions on repo submission, bookmark, and withdrawal messages; `role="alert"` on claim/unclaim errors; a proper label on the submit-repo input; sign-in/out buttons ignore double-clicks.
- Stale docs corrected against source: README's confidence explainer claimed every mission sits at `low` and that downstream-dependents/breaking-change signals weren't wired up (both false since ADRs 0029/0032); CHANGELOG entries and ADR footers still read "Proposed"/"draft" after the Accepted flip; `docs/data-model/README.md` gained the two post-launch scoring inputs and lost stale `deptend.dev` branding (README too); AGENTS.md §6/§13 notes updated to match the root typecheck script and ADR statuses.

### Added

- Loading skeletons for `/` and `/repo/[owner]/[name]` instead of blank screens during Neon reads. `/missions` deliberately gets none: a page-level skeleton would swap out the search input mid-navigation. _(Superseded by the read-path performance pass above, which ships one after confirming mid-board navigations don't mount it.)_
- Ranking-parity unit suite for `db/queries.ts` (real Drizzle SQL against a fake transport): locks `getBoardMissionsWithScoresPage()`'s ORDER BY to `rankMissions()`'s key sequence, plus filter/facet/pagination/shaping behavior; the ADR 0031 lockstep tripwire previously lived only in manual testing.

### Changed

- Security hardening: `Content-Security-Policy-Report-Only` header added (an enforced policy needs nonce middleware; deferred until the report is clean), and `ingest.yml` routes `workflow_dispatch` inputs through `env:` instead of direct shell interpolation.

**Downstream dependents sourced via libraries.io**; `ADR 0032`

### Added

- `EcosystemValueInputs.downstream_dependents` is now real data for repos whose published package(s) libraries.io can link: one paced API call per analyzed repo per ingestion run (max count across monorepo links), gated on a new free-tier `LIBRARIES_IO_API_KEY` (Actions secret + `.env.local`). The confidence flag is now conditional; a resolved count, including a genuine 0, clears it. Repos that resolve drop to a single structural flag (`no_lock_file`) and reach **`medium` confidence for the first time since Phase 2**; everything else stays honestly `null` + flagged. CLI output is unchanged (no keys in the CLI by design).
- Correction to this log's own record: the ADR 0029 entry below claims missions could "reach medium" after that change; against source they couldn't; `downstream_dependents_unavailable` was the second of two always-set flags until this ADR.

**Server-side pagination for the mission board + repo hardening**; `ADR 0031`

### Added

- `/missions` is now server-filtered, -sorted, and -paginated (50/page): filters and sort live in the URL and run as SQL against core's new `getBoardMissionsWithScoresPage`, which also returns per-axis facet counts; replacing the version that shipped every open+claimed mission to the browser for client-side filtering. Per-repo boards are unchanged. Ordering mirrors `rankMissions()`'s ADR 0017/0018 key sequence in SQL.
- Route-level test suites for all six mutating API endpoints (`repos` submit incl. the full manifest pre-check status mapping, claim/unclaim, bookmark/unbookmark, withdraw); closing the "near-zero `/app` route coverage" gap.
- Next.js error boundaries: route-segment `error.tsx`, root `global-error.tsx`, and a styled `not-found.tsx` (previously a thrown render or unknown URL got Next's default screens).
- The §6-step-6 `tsconfig.eslint.json` typechecks for `packages/core` and `cli` are wired into `ci.yml` as their own step.

### Changed

- `getIndexedRepoCount` / `getTotalRepoCount` use `count(*)` instead of loading every repo id into memory.

### Fixed

- The unbounded board query known issue: `/missions` DB read, payload, and client working set are now bounded per request regardless of total missions.

**Repo submission safeguards**; `ADR 0030`

### Added

- Manifest pre-check at submission: a repo with no analyzable `package.json`/`pyproject.toml`/`requirements.txt`/`go.mod` is now rejected before a row, and a repo-cap slot, is created, instead of silently landing as `ingestionStatus: "skipped"` later.
- Self-service withdrawal: a submitter can withdraw their own repo while it's still `pending`/`skipped`, without asking Mico to delete it by hand.

### Fixed

- `POST /api/repos` previously accepted a syntactically valid GitHub URL for a private, deleted, or nonexistent repo with no verification at all. The manifest pre-check's existence check closes this as a byproduct.

**Dead export removal**; `ADR 0031` follow-up

### Removed

- `getBoardMissionsWithScores()` (`packages/core/src/db/queries.ts`): the fetch-everything board query that ADR 0031's server-paginated `getBoardMissionsWithScoresPage()` superseded kept zero callers after that change. Historical mentions in ADRs 0019/0023/0027 stay as written; they were accurate when recorded.

---

## Post-Phase 6: Launch Readiness, 2026-07-25 to 2026-08-03

Standalone work between the phase plan's Phase 6 close and public launch, not tied to a numbered phase. `ADR 0023`–`0029`.

### Added

- **Go** added as a third supported ecosystem (`go.mod` parsing, Go module proxy registry lookups); `ADR 0024`.
- In-memory, per-session rate limiting on all mutating endpoints (repo submission, claim/unclaim, bookmark/unbookmark); zero-budget, keyed on authenticated GitHub login rather than IP; `ADR 0025`.
- Repo directory / browse view with per-user bookmarks, addressing the mission board's single-flat-list scaling problem; `ADR 0027`.
- `breaking_change_signals` now sourced from real GitHub Releases data instead of a hardcoded empty default; `ADR 0029`.

### Changed

- Local development and production now use separate Neon database branches, closing a gap where the two had shared one database (and one dataset) since Phase 0; `ADR 0023`.
- Repo cap raised from 10 to 150 ahead of public launch; `ADR 0028`.
- Mission `confidence` is no longer uniformly `"low"` for every mission. Missions with a resolvable dependency repo can now reach `"medium"` or, combined with a resolved lock file and CVSS score, `"high"`; the first time confidence has moved off `"low"` since Phase 2. (`downstream_dependents` remains unavailable, so `"low"` doesn't disappear project-wide.); `ADR 0029`.

### Fixed

- `__drizzle_migrations` had fallen three records behind the database's real applied state (each of the last two schema changes had needed a manual Neon SQL Editor apply after `drizzle-kit migrate` hung). Backfilled and reconciled; `ADR 0026`.

---

## Phase 6: PyPI Ecosystem Expansion, 2026-07-25

`ADR 0022`

### Added

- **PyPI** added as a second supported ecosystem: `pyproject.toml` (PEP 621) parsing, with `requirements.txt` as a fallback; PEP 440 version-range/bump handling.
- Ecosystem auto-detection by ordered probing (npm tried first, then PyPI); no `repos.ecosystem` column; ecosystem is decided fresh per ingestion run.

### Fixed

- OSV's PyPI advisories were parsed as if they used npm's `SEMVER`-type ranges. PyPI actually returns `ECOSYSTEM`-type ranges; every PyPI advisory would have silently returned an empty affected-version list and no fixed version, forever, with no error.

---

## Phase 5: Public Rescue Board, 2026-07-20 to 2026-07-22

`ADR 0019`–`0021`

### Added

- Public mission board: open and claimed missions across all indexed repos, filterable by severity and effort (this project's first client-side interactive component).
- Logged-in users can claim and unclaim missions.
- New `ingestionStatus: "skipped"` value, distinguishing a repo with no analyzable manifest from a genuine ingestion failure; repos that can never succeed no longer get retried forever by the nightly cron.

### Changed

- Repo cap raised from 3 to 10, based on an actual Neon storage measurement rather than the original estimate.

---

## Phase 4: CLI Companion, 2026-07-18

`ADR 0016`–`0018`

### Added

- `@deptend/cli`: npx-runnable CLI that reproduces the dashboard's exact scoring/ranking output entirely in-memory from a local repo path, with JSON export. Not yet published to the npm registry.

### Fixed

- Mission ranking's tie-break comparator wasn't transitive; the same missions could sort into different orders depending on database return order. Fixed by bucketing composite scores into fixed-width tiers.
- The final ranking tie-break (`created_at`) never actually discriminated between missions from the same ingestion run, because Postgres' `now()` is fixed for a transaction's lifetime. Switched to the advisory's own `published_at`, with `osv_id` as an absolute fallback. Found via cross-validating the CLI's output against the live dashboard on real data; both had the bug.

---

## Phase 3: MVP Dashboard, 2026-07-11

`ADR 0011`–`0015`

### Added

- Next.js dashboard live in production, GitHub OAuth login, repo submission flow, mission list with a "Why this score?" disclosure showing every scoring input.

### Changed

- Live at `deptend.vercel.app`, not `deptend.dev`; the domain remains unregistered (a small recurring cost against the zero-budget constraint) and `deptend.vercel.app` was made the project's permanent domain, not a placeholder.

### Fixed

- Tailwind CSS had never actually been wired up since Phase 0 (directives existed, but no PostCSS/Tailwind config did); every earlier build had silently shipped zero working styles.

---

## Phase 2: Scoring Engine, 2026-07-07

`ADR 0006`–`0010`

### Added

- Impact, effort, and ecosystem-value scorers; composite formula (`impact × 0.60 + ecosystem_value × 0.40`, effort as a tie-break only); deterministic mission copy generation.

### Fixed

- `db.transaction()` had never actually worked on the `neon-http` driver, silently, since unit tests mocked it. Switched to `neon-serverless` for the ingestion writer.
- OSV's batch endpoint returns only `{id, modified}` per result; every advisory ingested until this fix showed `severity: unknown` and a placeholder summary. Added a second detail-fetch stage.

### Known limitation introduced here

- Two scoring inputs (`downstream_dependents`, `has_migration_guide`/`breaking_change_signals`) had no data source and were stubbed rather than fabricated, with the direct effect that every mission showed `confidence: "low"` from this point on. Partially resolved in Post-Phase-6 (`ADR 0029`).

---

## Phase 1: Data Pipeline, 2026-07-02

No new ADRs.

### Added

- OSV and npm registry ingestion, `package.json` dependency parsing and tree resolution, daily ingestion cron in GitHub Actions.

---

## Phase 0: Foundation, 2026-06-30

`ADR 0001`–`0005`

### Added

- Monorepo scaffold (`/app`, `/cli`, `/packages/core`, `/scripts`), CI pipeline (lint/typecheck/test), Neon Postgres schema with Drizzle ORM (`schema.ts` as source of truth), two GitHub OAuth apps (dev + prod).
