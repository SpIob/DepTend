# ADR 0025 — Rate Limiting: In-Memory Over Redis

**Status:** Accepted
**Date:** 2026-07-27

---

## Context

No rate limiting existed on any auth-gated write endpoint — `POST /api/repos`, `POST /api/missions/[id]/claim`, `POST /api/missions/[id]/unclaim` — flagged as an open gap since Phase 3, carried unresolved through Phase 5, Phase 6, and the Go session's own backlog. With the board now genuinely public-facing (ADR 0023's dev/prod split) rather than traffic mostly limited to Mico's own repos, the gap became worth closing rather than continuing to carry.

## Decision

In-memory, per-serverless-instance sliding-window limiter — `createRateLimiter(limit, windowMs)` in `app/src/lib/rate-limit.ts` — keyed on the authenticated GitHub `login`, not IP. All three routes already require a session before any rate-limit check runs, so this sidesteps `x-forwarded-for` parsing and shared-IP false positives entirely. Two configured instances: `checkRepoSubmissionLimit` (5/hour, mirrors the spirit of the existing repo cap) and `checkMissionActionLimit` (20/minute, shared between claim and unclaim as the same class of action).

Chosen over `@upstash/ratelimit` + `@upstash/redis` (verified current at decision time: 500K commands/month, 256MB, no card required, permanent free tier since March 2025 — not a trial). Upstash is the technically correct choice: state persists across serverless instances and cold starts, this doesn't. But it requires a new third-party account and two new secrets, which the project's own rules require flagging as a decision point rather than adopting quietly. Mico's explicit call: in-memory — consistent with this project's demonstrated bias toward solving problems with what's already there (Neon branching over a new DB, a `postgres` devDependency over a new migration service) rather than adding new accounts.

**Known limitation, accepted deliberately, not an oversight:** state doesn't persist across concurrently-warm serverless instances, and resets on cold start / redeploy. A determined, distributed attacker could exceed the nominal limit. Judged good enough to stop one abusive session hammering an endpoint — this project's realistic threat model (solo passion project, no payments processed, no PII beyond a GitHub username) doesn't obviously justify Upstash's correctness guarantee today. Revisit with Upstash if that stops being true.

## What changed

- `app/src/lib/rate-limit.ts` — new. `createRateLimiter()` factory (discriminated-union return type, avoids the `exactOptionalPropertyTypes`/`noUncheckedIndexedAccess` traps this project has hit before) plus two configured limiter instances.
- `app/src/app/api/repos/route.ts` — rate-limit check added immediately after the existing session gate, before body parsing.
- `app/src/app/api/missions/[id]/claim/route.ts` — same pattern.
- `app/src/app/api/missions/[id]/unclaim/route.ts` — same pattern.

All four return `429` with a `Retry-After` header (seconds) on rejection.

## Verification

`pnpm typecheck`, `pnpm lint --max-warnings 0`, `prettier --check` all clean, run against the real repo in Claude's sandbox. `pnpm build` / `pnpm test` confirmed passing by Mico. Dedicated unit coverage added afterward (`app/src/lib/rate-limit.test.ts`, 13 tests) — the first tests `/app` has ever had; exercises limit/window enforcement, per-key isolation, sliding-window expiry, the `retryAfterSeconds ≥ 1` floor, and both configured instances, all driven by vitest's fake timers rather than real sleeps.

**Live-verified against `localhost:3000`, real GitHub OAuth session, 2026-07-28 (Mico):**

- `checkRepoSubmissionLimit` (5/hour): 5× `POST /api/repos` with an invalid body → `400` each; 6th → `429` with `Retry-After: 3599`. Clean, uncontaminated run — no prior submissions in the preceding hour.
- `checkMissionActionLimit` (20/minute): 21× `POST /api/missions/<nonexistent-uuid>/claim` → first 19 calls `404`, then `429` from call 20 onward, `Retry-After` values of `19` then `1`. One call earlier than a fresh-bucket run would predict — expected, not a bug: claim/unclaim draw from this same key-scoped bucket with no reset, and the immediately-preceding 404/409 tests below had already banked a hit or two still inside the 60s window when this loop started. The sharp `19 → 1` `Retry-After` drop between calls 20 and 21 has the same cause: those leftover hits were fired within a second or two of each other, so more than one aged out of the window in the ~0.4s between calls 20 and 21.
- `404` (`claim`/`unclaim` against a syntactically-valid but nonexistent mission id): confirmed — `{ error: "Mission not found." }`.
- `409 already_claimed`: confirmed — claiming an already-claimed mission returns `{ error: "This mission has already been claimed." }`.
- `409 not_claimed_by_you`: confirmed — unclaiming an open (unclaimed) mission returns `{ error: "This mission isn't currently claimed by you." }`.

All five outcomes (`400`, `404`, `409` ×2, `429` ×2) match the route code's documented behavior exactly. Closes the "claim/unclaim error paths untested against live data" gap open since Phase 5.

## Consequences

- No new dependency, no new secret, no new third-party account — zero-budget-compliant by construction, nothing to confirm.
- Does not close the underlying "distributed abuse" risk — a partial mitigation, not a complete one. If Upstash's free tier or this project's traffic profile ever makes that gap matter, this ADR should be explicitly revisited, not silently worked around.
- No logging or metrics on how often limits are actually hit — rate-limit activity is invisible in production beyond the `429` responses themselves. Worth adding if this becomes a recurring question.
