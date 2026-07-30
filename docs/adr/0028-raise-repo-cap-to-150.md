# ADR 0028 — Raise the Repo Cap from 10 to 150

**Status:** Accepted
**Date:** 2026-07-30
**Context:** Pre-launch (Week 0 of the zero-budget launch marketing plan)

---

## Context

The launch marketing plan targets Show HN, staggered Reddit posts, and a Product Hunt listing in Week 2 — channels that can send a few hundred visitors within hours. `NEXT_PUBLIC_MAX_REPOS` was still `10` (raised from the original `3` in ADR 0020, back at the Phase 5 → 6 transition). At that size, a real launch-day spike plausibly fills the cap in the first hour, and everyone who arrives afterward sees a submission wall instead of the product — directly undermining the launch's own primary objective (real, externally-submitted repos actually filling slots, not just traffic).

This is a pure re-application of ADR 0020's own reasoning at a new scale, not a new kind of decision:

1. **Storage headroom, checked against current measurements, not re-estimated from scratch.** Current Neon usage is ~40 MB against the 500 MB free-tier cap. The Go ecosystem addition (ADR 0024) — a whole new schema/feature surface, not just a few rows — only moved usage by ~7 MB, consistent with ADR 0020's own finding that per-repo/per-ecosystem storage cost is small relative to the fixed ~30 MB baseline (system catalogs, indexes across all 7 tables, `pgcrypto`, `__drizzle_migrations`, Neon's PITR window). Reserving a generous ~200 MB buffer for continued schema growth still leaves comfortable room well past 150 repos at any plausible per-repo cost seen so far.
2. **Ranking correctness at scale is already validated, not a new risk.** ADR 0017's tier-bucketing fix produces a real transitive equivalence class regardless of mission-list size, and was already explicitly designed with "if the repo cap is raised" in mind. Nothing about going from 10 to 150 reopens that question.
3. **Abuse/spam risk is independently bounded by ADR 0025, not by the cap itself.** `checkRepoSubmissionLimit` already rate-limits repo submissions to 5/hour per authenticated GitHub login, regardless of how high the overall cap is. Raising the cap doesn't remove that guardrail.

The 150 figure itself is deliberately conservative rather than derived from a hard ceiling: it assumes only a modest single-digit-percent visit-to-submission conversion rate even against an optimistic multi-thousand-visitor spike across Week 2's combined channels. If real uptake outpaces that, raising it again later is an env var change, not a migration — same as this one.

## Decision

**Repo cap raised from 10 to 150.** A config-value change only — `ecosystem`, `dep_type`, and every other schema enum are untouched; no migration involved, same as ADR 0020.

**Changed in this codebase:**

- `.env.example` — `NEXT_PUBLIC_MAX_REPOS="10"` → `"150"`. Also corrected an already-stale comment on the same line (`"Hard cap on indexed repos (MVP = 3)"` — a leftover from before ADR 0020 that was never updated when the cap became 10) to stop referencing a specific number that will drift again, pointing at this ADR instead.
- `app/src/app/api/repos/route.ts`, `app/src/app/page.tsx` — the `?? "10"` fallback default (only used if the env var is somehow unset) updated to `?? "150"`, so the two can't silently disagree with each other or with `.env.example`.
- `docs/data-model/README.md` — the `repos` table's MVP-constraint note updated to 150, now citing both this ADR and ADR 0020 for the full history.
- `packages/core/src/ingestor/registry.ts` — a comment aside (in the npm registry concurrency-budget explanation) citing the old "10 as of Phase 5" cap corrected to reference 150 / this ADR. Confirmed while editing that this comment's own point — registry fetches never overlap across repos because `scripts/ingest.js` processes them strictly sequentially — is unaffected by the cap size either way, same conclusion ADR 0020 reached at the previous cap change.

**Explicitly not changed, and why:**

- The DB schema — this is a config value, not a structural change.
- The ranking algorithm — already validated at scale by ADR 0017; 150 doesn't reopen that.
- The rate limiter (ADR 0025) — its 5/hour-per-user submission limit is an independent guardrail already in place; raising the overall cap doesn't need a matching rate-limit change.
- `README.md`'s repo-cap wording — checked directly rather than assumed: the current working copy no longer states a specific number there at all (it now reads "GitHub sign-in is only required to submit a new repo or claim a mission"), so there's nothing stale to fix in this pass.

## Operational steps outside this codebase change

Same caveat ADR 0020 flagged, and just as true this time: an env var default in code is not the same as the value actually in effect.

1. **Vercel Production environment variables** — `NEXT_PUBLIC_MAX_REPOS` must be updated to `150` directly in the Vercel dashboard (Project Settings → Environment Variables). This is a manual step outside this repo; nothing in this change touches it. (No available tool integration currently exposes environment-variable writes for this project — this has to be done by hand in the dashboard.)
2. **Local `.env.local`** — if local dev should reflect the new cap too, update it there. Per ADR 0023, local dev now points at a separate Neon branch, so this has no bearing on production correctness — it only matters for testing submissions locally against the new limit.
3. **Redeploy** — Vercel environment-variable changes require a new deployment (or a redeploy of the current one) to take effect; editing the dashboard value alone doesn't update a already-running deployment.

## Consequences

- No repo has been submitted against the new cap yet in this session — the change is parameterized (`submitRepo()` takes `maxRepos` as an argument, not a hardcoded value), so this should be a non-event the same way ADR 0020 predicted for 3→10, but per this project's own recurring lesson (ADR 0016 among others), "should be a non-event" and "confirmed a non-event" aren't the same claim. Worth a real submission past the old 10 once the Vercel env var is actually updated, to confirm end-to-end.
- Full local verification (`typecheck` → `test` → `build` → `lint` → `format:check`) was not run against a clean install in this pass — the working environment this change was prepared in didn't have a complete dependency install to run the full chain, so this is flagged rather than asserted. The diff itself is confirmed minimal and correct by direct inspection: five files, each a numeric-literal or prose-only change, no logic touched. Recommend Mico run the standard five-check sequence locally before merging, consistent with every prior phase's own gate — expected to be a non-event given the nature of the change, but not yet confirmed as one.
- `ingest.yml`'s daily cron has no batch-size limit of its own and already processes repos strictly sequentially (per the `registry.ts` finding, both this pass and ADR 0020's). Going from 10 to 150 doesn't introduce a new failure mode — a cron run with many more pending repos just takes proportionally longer, same conclusion as last time, now at a larger and more realistic launch scale.
