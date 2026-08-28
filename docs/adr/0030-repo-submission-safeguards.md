# ADR 0030; Repo-Submission Safeguards: Manifest Pre-Check and Self-Service Withdrawal

**Status:** Accepted
**Date:** 2026-08-07
**Phase:** none; standalone, post-plan session work (Roadmap "Now #4")

---

## Context

Roadmap's own Now-list has carried this since the launch-readiness pass: repo submission is session-gated and rate-limited (ADR 0025), but nothing evaluates the submission itself. With the cap raised for launch (150, ADR 0028) and submission genuinely public, nothing stops a repo with no relevant content; wrong tool for the job, not necessarily malicious; from consuming a cap slot. Today that failure mode is silent: the row gets created, the cap counts it, and only once ingestion actually runs does it show up as `ingestionStatus: "skipped"` (ADR 0021); by which point the slot is already spent.

Four options were raised and discussed with Mico:

- **A. Manifest pre-check at submission.** Verify the repo has an analyzable manifest before creating a row at all.
- **B. Self-service reclaim.** Let the original submitter withdraw their own still-unindexed submission.
- **C. Submitter trust heuristic, soft-flag only.** Surface new/thin-history GitHub accounts for visibility, without blocking.
- **D. Admin hidden-flag column.** A `repos.hidden` boolean, toggled by Mico, excluded from board queries. Needs a migration.

**Decision: A + B.** Both address the concrete, already-measurable failure mode (cap slots wasted on non-analyzable repos) without adding a schema migration or a judgment call about who counts as "trustworthy"; the exact kind of decision this project's own standing rules say to avoid making unilaterally when a simpler option covers the real, current risk. C and D are recorded here as deliberately not built yet, not rejected; see Consequences.

---

## Decision A; Manifest pre-check at submission

Reuses the real ingestion pipeline's own detection logic rather than adding a second implementation of "does this repo have anything DepTend can analyze": `fetchGitHubRepoMeta` (confirms the repo exists and gets its default branch) followed by `detectEcosystem` against the same three real ingestors (`NpmIngestor`, `PyPIIngestor`, `GoIngestor`) `scripts/ingest.js` and the CLI already use. New module: `packages/core/src/ingestor/manifest-check.ts`, exporting `checkSubmittableRepo(owner, name, token)`.

Wired into `POST /api/repos`, after URL parsing and before `submitRepo()`; a repo with no resolvable manifest is rejected before a row (and a cap slot) exists, instead of after.

**Side effect worth naming plainly:** this also closes a gap that had nothing to do with moderation; `POST /api/repos` previously did zero verification that the submitted repo actually exists or is public. A syntactically valid `github.com/owner/name` string for a private, deleted, or typo'd repo was accepted and inserted regardless. `fetchGitHubRepoMeta`'s 404 handling closes that for free, as a byproduct of solving the manifest problem, not a separate change.

**Token decision, flagged rather than resolved by inventing something new:** `GITHUB_TOKEN` is already in `.env.example`, already used by `scripts/ingest.js` and the CLI for this identical purpose ("avoid 60 req/hr rate limit"). It was never read anywhere in `/app` before this change. Reused here rather than adding a new variable; but whether it resolves to a real value in production depends on whether `GITHUB_TOKEN` is actually set as a **Vercel** env var, which is a separate fact from GitHub Actions' own auto-injected token of the same name (Actions-only, never available here). Not confirmed either way as of this ADR. If it's unset in Vercel, this runs unauthenticated: 60 req/hr, shared globally across all of `/app`'s traffic, not per submitter. Given the existing 5/hour-per-user submission rate limit (ADR 0025) and the current, much lower real submission volume, this is judged acceptable for now; but it's the first place in this project where an unauthenticated GitHub REST ceiling is shared across _all_ users at once rather than bounded per-user, worth watching the same way ADR 0025's own cross-instance gap is being watched this launch week.

**What this deliberately does not do:** it isn't a security boundary, and it isn't general spam prevention. A submitter who wants to get past it only needs a trivially real manifest; this targets the specific, common, non-adversarial case (wrong kind of repo for this tool), not a determined bad actor.

---

## Decision B; Self-service withdrawal

New `withdrawOwnRepo()` in `packages/core/src/db/repos.ts`; same guarded-statement shape as `unclaimMission()`/`unbookmarkRepo()`: a single `DELETE ... WHERE id = ? AND submitted_by = ? AND ingestion_status IN ('pending', 'skipped')`, no transaction (neon-http doesn't support one, ADR 0009; a single guarded statement is already atomic), with a follow-up `SELECT` only when nothing matched, to distinguish "doesn't exist" from "exists but isn't yours or isn't withdrawable"; mirroring the exact distinction `unclaimMission()` draws for `not_claimed_by_you`.

**Scope of "withdrawable," deliberate:** `pending` and `skipped` only. `complete` is excluded because a repo in that state may carry real missions other people can see or claim; no longer just the submitter's own thing to walk back. `running` is excluded to avoid deleting a row out from under an in-flight ingestion job. `failed` is excluded on purpose too: `resolvePending()` already retries `failed` repos automatically, so a transient failure self-heals without the submitter needing to do anything; offering withdrawal there would just be a second way to abandon a repo that was probably going to succeed on retry.

New route: `POST /api/repos/[id]/withdraw`, same session + rate-limit (shared `checkMissionActionLimit` pool, same bucket as claim/unclaim/bookmark/unbookmark) + UUID-validation shape every other mutation route already follows. New component `WithdrawButton`, wired into the per-repo page's existing pending/skipped empty state; renders `null` unless the signed-in viewer is literally the submitter and the repo is still in a withdrawable status, so it simply doesn't appear for anyone it doesn't apply to, rather than appearing and then failing. Two-step confirm (not a `window.confirm` dialog, no new dependency) since this is destructive and, unlike a bookmark, not reversible from the UI.

---

## Consequences

**What this closes:** the two concrete, already-flagged gaps; cap slots silently spent on non-analyzable repos, and no way for a submitter to correct their own mistake short of asking Mico to run SQL by hand.

**What this deliberately does not close, recorded so it isn't silently re-raised as an oversight later:**

- **Deliberate spam with a real manifest still gets through.** Options C (soft-flag on submitter trust signals) and D (admin hidden-flag, reversible, needs a migration) were both discussed and both deferred, not rejected; the right next step if A+B turns out not to be enough once real launch traffic arrives, not a hypothetical.
- **The unauthenticated global GitHub rate-limit ceiling**, if `GITHUB_TOKEN` isn't actually set in Vercel; see Decision A. Worth confirming one way or the other rather than assuming.
- **Withdrawal only ever removes a row Mico himself would otherwise have had to delete by hand**; it doesn't touch the pre-existing pre-split test-data cleanup (ADR 0023's own addendum) or provide any admin-side moderation at all. Those remain separate, already-tracked items.

---

## Verification

Full clean five-check loop (`typecheck` → `test` → `build` → `lint --max-warnings 0` → `format:check`), plus both packages' `tsconfig.eslint.json` checks, all passing:

- `packages/core`: 558 tests (up from 548); 6 new in `manifest-check.test.ts`, 6 new in `repos.test.ts` (`withdrawOwnRepo`).
- `app`: 16 tests, unchanged (no new `/app`-level tests added this session; consistent with this project's existing pattern of testing the core logic thoroughly and the route wiring by manual/live verification, same as every other API route here).
- `cli`: 18 tests, unchanged.
- `pnpm build`: new `/api/repos/[id]/withdraw` route appears in the build output; `/repo/[owner]/[name]`'s bundle size is unchanged (121 kB); `WithdrawButton` renders `null` for the overwhelming majority of viewers, so its cost is negligible even though it's always mounted.

**Not yet done, and explicitly not claimed here:** no live verification against a real Neon database, real GitHub API calls, or real Vercel deployment; everything above is local build/test/typecheck/lint only, the same honest boundary this project's own status docs have always drawn between "verified by Claude's sandbox" and "verified live by Mico." In particular:

- A real submission of a manifest-less repo, confirming the 400 rejection and that no row was created.
- A real submission confirming the byproduct fix (private/nonexistent repo now rejected) actually works against the live GitHub API, not just the mocked test fixtures.
- A real withdrawal, confirming the row and its cap slot are actually gone from the live board afterward.
- Whether `GITHUB_TOKEN` is actually set in Vercel today, and if not, a decision on whether to add it.

---

## Correction (found before live verification, not a new ADR)

`POST /api/repos`'s original status-code mapping collapsed three of `checkSubmittableRepo`'s four failure reasons onto a single `503`, keeping only `no_manifest` at `400`. That put the exact case this ADR's own "byproduct" note calls out; a private, deleted, or typo'd repo; behind a `503 Service Unavailable`, which tells a client "retry later" when retrying can never help; the repo isn't going to appear. Fixed to an exhaustive `switch` over `manifestCheck.reason`, matching the outcome-`switch` idiom `withdraw/route.ts` (Decision B, this same ADR) already established:

| Reason                | Status            | Why                                                                                         |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `no_manifest`         | 400               | Unchanged — a problem with the repo's content, not its existence.                           |
| `not_found`           | **404** (was 503) | The repo doesn't exist, is private, or was typo'd — a request problem, not a transient one. |
| `rate_limited`        | 503               | Unchanged — our own call to GitHub's API hit a rate limit; genuinely transient.             |
| `verification_failed` | 503               | Unchanged — an unexpected error verifying the repo; genuinely transient.                    |

No test coverage added at the route level, consistent with this ADR's own verification note above (`checkSubmittableRepo`'s reason categorization is already covered in `manifest-check.test.ts`; route-level status-code wiring for every other route in this project is verified live, not with route-level unit tests). Full five-check loop re-run clean after the fix.
