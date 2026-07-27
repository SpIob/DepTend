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

`pnpm typecheck`, `pnpm lint --max-warnings 0`, `prettier --check` all clean, run against the real repo in Claude's sandbox. `pnpm build` / `pnpm test` confirmed passing by Mico.

**Not yet exercised:** actually triggering a real `429` against live/dev data — six rapid repo submissions, or six rapid claim/unclaim toggles. Worth a quick live pass before flipping this ADR to Accepted, same closing pattern every prior ADR has followed.

## Consequences

- No new dependency, no new secret, no new third-party account — zero-budget-compliant by construction, nothing to confirm.
- Does not close the underlying "distributed abuse" risk — a partial mitigation, not a complete one. If Upstash's free tier or this project's traffic profile ever makes that gap matter, this ADR should be explicitly revisited, not silently worked around.
- No logging or metrics on how often limits are actually hit — rate-limit activity is invisible in production beyond the `429` responses themselves. Worth adding if this becomes a recurring question.
