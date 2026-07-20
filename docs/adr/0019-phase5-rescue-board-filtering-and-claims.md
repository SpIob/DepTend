# ADR 0019 — Phase 5 Rescue Board: Filtering Mechanism, Impact Filter Axis, Claim Reversibility

**Status:** Proposed
**Date:** 2026-07-20
**Phase:** 5 (public rescue board)

---

## Context

Phase 5's exit criteria (project plan §7): a public-facing board listing open, high-leverage missions across all indexed repos, filterable by effort and impact, with a logged-in user able to claim a mission.

Before writing any code, a structural audit of the real repo (a Mico-uploaded snapshot, cross-checked against `Phase4_Status.md`) confirmed `missions` already has everything the claim feature needs — `status` (`mission_status` enum: `open`/`claimed`/`resolved`/`dismissed`, indexed via `idx_missions_status`), `claimedBy`, `claimedAt`, plus `resolvedAt`/`dismissedAt`/`dismissReason` for later — all provisioned since Phase 0/2, unused until now. **No schema migration for this phase.**

Three decisions needed before implementation, discussed with Mico at kickoff:

### 1. How should mission filtering work?

The existing dashboard (`app/src/app/page.tsx`) is a server component with zero client JS — every interactive-feeling piece so far (the "Why this score?" disclosure) uses native `<details>`, no hooks, no client bundle. Two options:

- **URL-based filters** — a native `<form method="get">`, server component re-reads `searchParams` and re-queries. No client JS, consistent with the project's pattern to date, but each filter change is a full page round-trip.
- **Client-side JS filtering** — fetch the board once, hold filter state in a client component, filter the already-loaded array in memory. Introduces this project's first real interactive client component, but filtering feels instant.

**Decision: client-side JS.** Mico's explicit call over the zero-JS default.

### 2. What should the "impact" filter use?

`advisories.severity` (`critical`/`high`/`medium`/`low`/`unknown`) is categorical and already the basis of the dashboard's `SeverityMark` component. `mission_scores.compositeScore`/`impactScore` are numeric and would need a range control (slider or min/max inputs).

**Decision: severity level.** Matches the categorical shape of the existing effort-label filter and what's already surfaced in the UI — no new numeric-range UI component needed.

### 3. Should claiming be reversible?

The project plan's Phase 5 exit criterion only says "a logged-in user can claim a mission" — literally claim-only. But a one-way claim with no way to release it risks missions getting stuck claimed indefinitely (changed mind, abandoned attempt, no admin panel to intervene) — a bad look for a board whose whole point is surfacing available work.

**Decision: claim + unclaim.** Mico's explicit call over the literal claim-only spec. Same guarded-update mechanism in both directions, symmetric cost to build.

## Decision

**Data layer, delivered this pass:**

- `packages/core/src/db/missions.ts` — `claimMission(db, missionId, claimedBy)` and `unclaimMission(db, missionId, requestingUser)`. Each is a single guarded `UPDATE ... WHERE` — not a transaction (same reasoning as `submitRepo()` in ADR 0013: `/app`'s `neon-http` driver doesn't support `db.transaction()` per ADR 0009, but a single conditional `UPDATE` is already atomic on its own). `claimMission` only succeeds while `status = 'open'`; `unclaimMission` only succeeds while `status = 'claimed' AND claimed_by = requestingUser` — so only the claimant can release their own claim, and a lost race just returns a distinguishable outcome (`already_claimed` / `not_claimed_by_you`) rather than throwing or silently no-op'ing.
- `packages/core/src/db/queries.ts` — `getOpenMissionsWithScores()` refactored onto a shared `getMissionsWithScoresByStatus()` helper (same join, same `rankMissions()` call, parameterized status filter — no behavior change for existing callers). New `getBoardMissionsWithScores()` returns `open` + `claimed` missions (not `resolved`/`dismissed` — no UI surfaces either state yet). The rescue board shows claimed missions too, marked as such, so it also answers "what's already being worked on," not just "what's left" — reduces duplicate effort across claimants.
- `packages/core/package.json` — `./db/missions.js` added to the exports map, alongside the existing `./db/repos.js`.

**API routes, delivered this pass (Step 2):**

- `app/src/app/api/missions/[id]/claim/route.ts` — `POST`, session-gated (401 if signed out), validates the route param is UUID-shaped (400 otherwise), calls `claimMission()`, maps its outcome to `404`/`409`/`200`.
- `app/src/app/api/missions/[id]/unclaim/route.ts` — same shape, calls `unclaimMission()`.
- `packages/core/src/db/missions.ts` — added `isValidMissionId()`, an input-shape guard in the same role `parseGithubUrl()` plays for `repos.ts`: without it, a malformed route param reaches Postgres as a raw "invalid input syntax for type uuid" error instead of a clean `400` at the API boundary.

Both routes follow `app/src/app/api/repos/route.ts`'s established shape exactly: `getServerSession(authOptions)` → `session?.user?.login` → `NextResponse.json(..., { status })`. Next.js 15's async route params (`{ params: Promise<{ id: string }> }`, same pattern already used by the NextAuth catch-all route) required an `await params` before use.

**UI layer, delivered this pass (Step 3):**

- `app/src/components/mission-board.tsx` (new, `"use client"`) — holds the filter state (`Set<Severity>`, `Set<EffortLabel>`) and a local copy of the mission list seeded from the server-fetched array; filters in memory and re-renders instantly. Also owns `handleStatusChange()`, applied as a patch to the one affected mission after a successful claim/unclaim, so the board reflects the change without a full page reload.
- `app/src/components/mission-filter-bar.tsx` (new) — presentational toggle-chip UI for severity and effort. No `"use client"` of its own; it's only ever imported from `mission-board.tsx`, so it's already inside that client boundary.
- `app/src/components/mission-card.tsx` (rewritten, now `"use client"`) — the claim/unclaim UI (`ClaimAction`) is a self-contained fetch + request-state component, the same pattern `SubmitRepoForm` already established: `fetch()` the route, parse the JSON body, map to an `idle`/`pending`/`error` state. Only calls `onStatusChange` (bubbling up to `MissionBoard`) on success. Renders one of four states depending on `mission.status` and the signed-in user's login (from `useSession()`, not passed down as a prop): claim button, unclaim button, "Claimed by @username" (read-only), or a sign-in prompt.
- `app/src/lib/queries/missions.ts` — added `getBoardMissions()`, wrapping the core `getBoardMissionsWithScores()` behind `/app`'s own db client, same shape as the existing `getOpenMissions()`.
- `app/src/app/page.tsx` — now calls `getBoardMissions()` and renders `<MissionBoard>` instead of a raw server-rendered `<ul>`.

This is the project's first real client-side interactive component (previous interactivity — `AuthStatus`, `SubmitRepoForm` — used `"use client"` for session/form state, but nothing filtered or re-rendered a list in the browser). `/`'s First Load JS is now ~115 kB, up from a purely static server-rendered page.

## Consequences

- Verified from a clean state (`rm -rf` every `dist`/`.next`): `typecheck`, `test` (278/278 — 265 in `packages/core`, up from 249 at Phase 4 close; 13 in `cli`, unchanged), `build` (all four API/page routes appear correctly in the Next.js route table; `/`'s bundle is now ~4 kB page-specific / 115 kB First Load JS, this project's first non-trivial client bundle), `lint` (`--max-warnings 0`), `format:check` — all exit 0.
- `claimMission`/`unclaimMission` are covered by 7 unit tests, `isValidMissionId` by 9, in `missions.test.ts`, using the same chainable-stub mock strategy as `repos.test.ts`. `getBoardMissionsWithScores()` and everything under `/app` (API routes, `MissionBoard`, `MissionCard`, `MissionFilterBar`) have no new unit tests — consistent with existing project convention (Phase 3's own outstanding-items note: `/app` has never had Vitest coverage, only live/manual verification).
- **New finding this step:** `next build`'s own internal lint pass caught a real bug (`@typescript-eslint/no-unnecessary-condition` on a redundant `login !== undefined` check in `mission-card.tsx`) that `pnpm lint` — the project's own `eslint.config.mjs`, with a "Next.js plugin was not detected" warning printed alongside it — did not. `next build` appears to apply a stricter/different rule set at build time than the project's own flat config does standalone. Fixed the specific instance (the check was genuinely redundant — `claimedBy === login` between a `string | null` and a `string | undefined` already narrows both to `string`). Worth keeping in mind for future UI work: `pnpm lint` passing clean doesn't guarantee `next build`'s lint step will too, so `pnpm build` staying in the standard verification sequence (not just `typecheck`+`lint`) is doing real work, not just redundant coverage.
- Not yet verified live: no real claim/unclaim has run against Neon yet, and neither has the filter UI been exercised against real board data with a mix of open/claimed missions and varied severities. First real test happens once this is deployed and Mico exercises it from a signed-in session against production data.
