# ADR 0027; Repo-First Navigation and Repo Bookmarks

**Status:** Accepted; verified live, local and production
**Date:** 2026-07-29 (proposed); verified 2026-07-30
**Phase:** none; standalone UX/scale improvement, not tied to a numbered phase (per the project's own open-ended post-Phase-6 roadmap)

---

## Context

Raised by Mico directly, with a production screenshot: the mission board's single flat list doesn't scale. Confirmed against the real code, not assumed:

- `getBoardMissionsWithScores()` (`packages/core/src/db/queries.ts`) has no `LIMIT` and no repo scoping; it joins and ranks every `open`/`claimed` mission across **every** indexed repo on every request.
- `MissionBoard` (`app/src/components/mission-board.tsx`) is a client component that receives that entire array and does all search/filter/sort/group-by-repo in the browser. "Group by repo" only changes how that same full list renders into `<h2>` sections; it doesn't reduce what's fetched or shipped to the client.
- Result: page weight and scroll length grow linearly with total missions across every repo ever submitted, not with what one visitor actually came to look at. Already 124 missions across 4 repos in the screenshot Mico shared; the repo cap has already been raised once (3 → 10, ADR 0020) and nothing stops it being raised again.
- Separately: `app/src/app/page.tsx`'s content column is `max-w-3xl` (768px), centered, with no other use for the rest of the viewport.
- There is currently no way for a signed-in user to mark a repo for quicker return access; `repos` carries no per-user state at all, consistent with this project's existing pattern of storing the GitHub login directly on the row that needs it (`missions.claimedBy`, `repos.submittedBy`) rather than a `users` table.

Three related decisions, discussed with Mico at kickoff:

### 1. How should navigation be structured?

- **Keep one flat board, add pagination/virtualization.** Caps the _rendered_ DOM size but not the underlying query or the payload; and adds real complexity (cursor/offset state, a virtualization library or hand-rolled windowing) for a problem a simpler structural change solves outright.
- **Repo-first: a directory page, drilling into a per-repo mission page.** Matches how the data is already organized; every mission already belongs to exactly one repo; and bounds both the query and the payload by one repo's mission count instead of the whole board's.

**Decision: repo-first.** Mico's explicit request, and the only option of the two that actually fixes payload growth instead of just hiding it.

### 2. Should repo bookmarking exist, and if so, how?

- **A column on `repos`.** Rejected outright; a bookmark is inherently a (user, repo) pair; `repos` is one shared global row, not owned by a single user.
- **A new `repo_bookmarks` join table**, GitHub login stored directly (same pattern as `claimedBy`/`submittedBy`), no separate `users` table.

**Decision: new table.** It's the only shape that fits a many-to-many (user, repo) relationship on this schema. Flagging this as a schema migration per the project's own standing rule; not something to implement without sign-off.

### 3. What happens to the freed-up layout width?

- **Widen the mission list's reading column.** Rejected; mission cards are prose-heavy (title, description, action hint, scoring breakdown); `max-w-3xl` is a readability choice, not an oversight, and stretching it across a 1440px+ viewport would hurt scanability more than help it.
- **Use the width on the new repo directory page instead**, which is card/grid content, not prose, and is a genuinely better fit for a wider, multi-column layout.

**Decision: widen only the directory page**, as a grid. The mission list/detail pages keep their current reading width.

## Decision

### 1. Repo-first navigation

```
app/src/app/
  page.tsx                       # REWRITTEN — repo directory, was the flat mission board
  repo/[owner]/[name]/page.tsx   # NEW — today's mission board UI, scoped to one repo
  missions/page.tsx              # NEW — today's flat board, moved here unchanged
```

`repos` already has a `unique(owner, name)` constraint (`repos_owner_name_unique`), so `/repo/[owner]/[name]` is a clean, human-readable, lookup-free URL; no UUID in the address bar, no extra existence-check round trip beyond the query the page needs anyway.

`/missions` keeps today's `MissionBoard`/`MissionFilterBar`/`MissionCard`/search exactly as-is, just moved off the root route; zero rework, for anyone who wants a single cross-repo feed. Not required by anything Mico asked for, but free to keep since it's already built; can be cut later if it goes unused.

**New reads, `packages/core/src/db/queries.ts`:**

- `getReposWithMissionSummary(db, userLogin?)`; one row per repo: `owner`, `name`, `defaultBranch`, ecosystems present (distinct `dependencies.ecosystem` for that repo), mission counts by severity (conditional aggregation over the existing missions→advisories join, `open`+`claimed` only, same status filter `getBoardMissionsWithScores` already uses), `lastIngestedAt`, `ingestionStatus`, and, if `userLogin` is passed, `isBookmarked`. Bounded by repo count (10 today), not mission count, which is the whole point of this change.
- `getMissionsWithScoresByStatus` (existing shared helper) gains an optional `repoId` filter, reused by both `getBoardMissionsWithScores()` (unchanged behavior, no filter passed) and a new `getRepoMissionsWithScores(db, repoId)` for the per-repo page.

**No changes needed** to `MissionBoard`, `MissionFilterBar`, `MissionCard`, `SeverityMark`, or `EcosystemBadge`; they already operate on whatever `MissionWithScore[]` they're handed. Scoping that array to one repo is a data-layer change, not a component change.

### 2. Repo bookmarks

**Schema; `packages/core/src/db/schema.ts`, new table:**

```ts
export const repoBookmarks = pgTable(
  "repo_bookmarks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    userLogin: text("user_login").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Leads with user_login: "list this user's bookmarks" (the repo
    // directory's own read pattern) is the primary access path, not
    // "list this repo's bookmarkers" — no product surface needs that.
    unique("repo_bookmarks_user_repo_unique").on(table.userLogin, table.repoId),
  ],
);
```

Mirrors existing conventions exactly: uuid PK, cascading FK, a unique constraint doing double duty as the lookup index, no separate `users` table; same shape as every other table in `schema.ts`.

**Writes; new `packages/core/src/db/bookmarks.ts`, same guarded-write shape as `db/missions.ts`'s `claimMission`/`unclaimMission` and `db/repos.ts`'s `submitRepo`:**

- `bookmarkRepo(db, repoId, userLogin): Promise<"bookmarked" | "already_bookmarked" | "not_found">`; existence check on `repos` first (same shape `submitRepo` already uses), then `insert(repoBookmarks).onConflictDoNothing({ target: [repoBookmarks.userLogin, repoBookmarks.repoId] }).returning()`. Existence is checked up front rather than caught as a raw FK-violation error, so the route never has to parse a driver-level Postgres error to produce a clean `404`.
- `unbookmarkRepo(db, repoId, userLogin): Promise<"unbookmarked" | "not_bookmarked">`; single guarded `DELETE ... WHERE repo_id = ... AND user_login = ...`. Same simplification `unclaimMission` already uses: "never bookmarked" and "repo doesn't exist" collapse into one outcome, since the caller's remedy is identical either way; nothing to remove.
- No transaction in either; same reasoning as every other write in this project (ADR 0009: `neon-http` doesn't support `db.transaction()`; a single guarded statement is already atomic on its own).

**Routes:**

- `app/src/app/api/repos/[id]/bookmark/route.ts`; `POST`, session-gated, same shape as the claim/unclaim routes (`getServerSession` → `session?.user?.login` → outcome → status code).
- `app/src/app/api/repos/[id]/unbookmark/route.ts`; same shape.
- Both reuse the existing `checkMissionActionLimit` rate limiter (`app/src/lib/rate-limit.ts`) rather than adding a new bucket; a bookmark toggle is the same class of lightweight per-user action claim/unclaim already share a pool for. Open to a dedicated limiter if Mico wants bookmarks isolated from mission-action traffic; reusing the existing one is less code for the same protection.
- Route-param UUID validation: today's `isValidMissionId()` (`db/missions.ts`) is a generic UUID-shape regex despite its mission-specific name. Plan is to extract it to a shared `isValidUuid()` rather than duplicate the same regex a third time; small refactor, zero behavior change, existing callers unaffected.

**UI:**

- A bookmark toggle (star or similar) on each repo directory card, and on the per-repo page header; same self-contained fetch + request-state pattern `ClaimAction` already established in `mission-card.tsx`.
- Signed-out users see the toggle disabled with a sign-in prompt, same pattern `MissionCard` already uses for claim.
- Directory page: bookmarked repos sort first (or a "bookmarked only" toggle) when signed in; exact mechanism left as an implementation detail, not a decision needing sign-off.

### 3. Layout

- Directory page (`page.tsx`): wider container (`max-w-6xl` or similar), responsive card grid; 1 column on narrow viewports, 2–3 on wide ones.
- `/repo/[owner]/[name]` and `/missions`: keep today's `max-w-3xl` reading column, unchanged.
- No new design tokens needed; reuses the existing `bg`/`surface`/`border`/`ink`/`accent`/`severity`/`ecosystem` palette and monospace-forward type system as-is (`tailwind.config.ts`).

## Free-tier compliance

No new cost, no new service, no new third-party account, no new runtime dependency. `repo_bookmarks` is one more table in the same Neon free-tier database already in use; negligible storage at this project's scale (10-repo cap, one row per user-repo bookmark). Rate limiting reuses the existing in-memory limiter (ADR 0025), not Upstash. Zero-budget constraint holds.

## Consequences

- **Schema migration applied to both Neon branches.** Plain `CREATE TABLE`, not an enum add; applied cleanly on both, no repeat of the `ALTER TYPE` hangs from ADR 0021/0026.
- Existing routes, queries, and components for the flat board were reused, not rewritten; `MissionBoard` and friends just receive a smaller, repo-scoped array now. All regression risk stayed concentrated in the new aggregate query and the two new bookmark routes, exactly as predicted; nothing broke in already-shipped code.
- `/`'s bundle came in lighter than `/missions`, confirmed by the real build: 116 kB vs. 120 kB First Load JS. `/repo/[owner]/[name]` sits at 121 kB, inheriting `MissionBoard`'s existing cost unchanged.
- Root route's canonical content changed from "every mission" to "every repo." No external consumer of `/` expecting a mission list surfaced as a problem.
- `bookmarkRepo()`'s two sequential round trips (existence check, then insert) turned out not to matter; see "Cold start vs. per-request cost," below.

## Live Verification

**Automated, run in a clean sandbox before handoff:** `typecheck` (both `tsconfig.eslint.json` checks included), `test` (447/447 `packages/core`, 9 of them new; 17/17 `cli`; 13/13 `app`), `lint --max-warnings 0`, `format:check`, and a full clean `build`; all clean. Route table and bundle sizes confirmed as above.

**Local (`pnpm --filter app dev`), by Mico:**

- Repo directory renders correctly; cards, manifests, mission counts split by severity, all as designed.
- Bookmark toggle works end to end; the row showed up in `repo_bookmarks` on the dev-branch Neon console, confirmed by direct query.
- Rate limiting confirmed working as designed: clicking the bookmark toggle in quick succession hit a real `429` from the shared `checkMissionActionLimit` pool.
- **One real bug, found and fixed:** the bookmark star was too small (16px) to comfortably click. Bumped to 20px with a small padding hit-area; re-verified clean (typecheck/lint/format/build) before re-delivering.
- **Signed-out bookmark click, investigated in depth:** initial testing showed clicking the star while signed out immediately signed Mico back in with no visible prompt, which looked like a bug. Re-tested in an incognito window with no lingering GitHub session; confirmed a real GitHub "Authorize deptend.dev" consent screen appears, as expected. Root cause of the original observation: signing out of deptend.dev only clears deptend's own session cookie, not GitHub's own SSO session; `signIn("github")` silently re-approves against a still-active GitHub session with prior consent already granted. Not a bug, not new behavior (the claim flow's sign-in link would do the same thing), and not specific to bookmarks. No code change.
- **Cold start vs. per-request cost, investigated in depth:** the first bookmark action took ~1–2s; every action after that was fast. This isolates the latency to Neon's free-tier compute auto-suspend/wake behavior, not to `bookmarkRepo()`'s two sequential round trips (existence check, then insert); if the two round trips were the real cost, every request would be slow, not just the first. No code change; the existence-check-first design (ADR 0027's own reasoning: a clean `404` instead of a caught FK-violation error) stands as delivered.

**Production (`deptend.vercel.app`):**

- Vercel build succeeded clean from the delivered patch, first try; no repeat of ADR 0015's original build-ordering failure.
- Same behaviors confirmed as local: bookmark round trip against prod-branch Neon, the same OAuth SSO re-authorization pattern, the same cold-start-then-fast pattern. No environment-specific regressions.

## Sequencing

Repo directory + per-repo page first; it's the change that actually fixes the scaling problem, and bookmarks only make sense once there's a real per-repo destination to bookmark toward. Layout width is addressed as part of the directory page, not a separate pass.

## Open items, flagged rather than assumed

None of these were challenged; all four defaults shipped exactly as proposed:

- URL shape `/repo/[owner]/[name]` (not a UUID-based route).
- `/missions` kept as a secondary "browse everything" view rather than removed outright.
- Bookmark endpoints share the existing `checkMissionActionLimit` rate-limit pool rather than getting a dedicated one; confirmed working as intended during live verification (see above).
- Table/column names as drafted above (`repo_bookmarks`, `user_login`, `repo_id`).
