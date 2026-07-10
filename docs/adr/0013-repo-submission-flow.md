# ADR 0013 — Repo Submission Flow

**Status:** Accepted
**Date:** 2026-07-10
**Phase:** 3 (repo submission)

---

## Context

Phase 3's remaining MVP-DoD item: a signed-in user can submit a public GitHub repo URL, it gets ingested, and missions appear. The scoring pipeline, ingestion pipeline, and mission rendering all already exist (Phases 1–3) — what's new is the write path (a `repos` row) and getting that row processed without waiting for the next scheduled run.

Two things needed a decision before writing code.

### 1. How does a submitted repo actually get processed?

`scripts/ingest.js`'s default (no-args) mode already processes every `repos` row with status `pending`/`failed` — so the existing daily cron (`ingest.yml`, `0 4 * * *`) would pick up a freshly-submitted repo automatically, with zero pipeline changes. The only question was latency. Three options, discussed with Mico:

- **Cron only.** Zero new secrets, zero new moving parts. Up to ~24h before a submission is processed.
- **Cron + on-demand `workflow_dispatch` trigger** from the submission API route, so the same `ingest.yml` job runs within seconds/minutes instead of waiting for the schedule. Needs a new GitHub PAT with `actions: write` scope.
- **Synchronous ingestion inside the API route itself.** Rejected outright — the original project plan's own risk register already calls this out ("Vercel cold starts make API routes too slow for ingestion... API routes only serve pre-computed results"), and a real dependency tree plus OSV/npm/GitHub calls could exceed Vercel's serverless timeout regardless.

**Decision: cron + on-demand `workflow_dispatch`.** `ingest.yml` already had a `workflow_dispatch` trigger with a `repo_id` input (built in Phase 1, originally for manual debugging/replay) — it just needed a second input so the API-triggered path can be told apart from a human clicking "Run workflow" in the GitHub UI, and `scripts/ingest.js`'s `--triggered-by` validation needed to accept the `"submit"` value the schema comment had anticipated since Phase 0 but nothing had ever sent.

### 2. The MVP repo cap check has a real (accepted) race condition

`repos.github_url` and `(owner, name)` both have unique constraints, so two simultaneous submissions of the _same_ repo are already handled correctly at the DB level. The 3-repo cap has no equivalent constraint — enforcing it means "count, then insert," which is two queries, not one atomic statement. Two submissions of _different_ repos arriving in the same instant, when exactly one slot remains, could both pass the count check and both insert, landing at 4.

Two ways to close this were considered and both rejected for this delivery:

- A `db.transaction()` around count-then-insert — not available; `/app` uses `neon-http` (ADR 0012's `ReadonlyDb`), and `neon-http` doesn't support interactive transactions at all (ADR 0009, same underlying limitation that drove the ingest script to `neon-serverless`).
- A single guarded `INSERT ... SELECT ... WHERE (SELECT COUNT(*) ...) < n` statement — genuinely atomic and `neon-http`-compatible, but Drizzle's `.insert().select()` builder doesn't have a clean shape for "literal values, no source table, WHERE-guarded," and forcing raw SQL for a corner this narrow was judged not worth deviating from the project's established Drizzle-query-API-only convention (Phase 1 decision, never violated since).

**Decision: accept the race.** This is a solo-developer MVP with no concurrent traffic in practice; the failure mode if it ever happens is "4 repos instead of 3 for a while," not a correctness or security issue. Documented inline in `submitRepo()` rather than silently shipped — same pattern as the `missions` no-unique-constraint trade-off in ADR 0008.

## Decision

Built:

- `packages/core/src/db/repos.ts` — `parseGithubUrl()` (validates/normalizes a submitted URL; only accepts `github.com`, matching "only public repository data may be ingested" from the project's data & privacy rules) and `submitRepo()` (existence check → cap check → guarded insert, all Drizzle query API, no raw SQL).
- `app/src/app/api/repos/route.ts` — `POST` handler: requires a session (401 otherwise), validates the URL, calls `submitRepo()`, and on success calls the new dispatch helper.
- `app/src/lib/github-dispatch.ts` — `triggerIngestion()`, a `fetch()` to GitHub's `workflow_dispatch` REST API. Best-effort: if it fails, the repo row still exists and the daily cron is the fallback — the request doesn't fail just because the immediate-trigger call did.
- `app/src/components/submit-repo-form.tsx` — sign-in prompt if unauthenticated, cap message if `getTotalRepoCount() >= NEXT_PUBLIC_MAX_REPOS`, form otherwise.
- `.github/workflows/ingest.yml` — added a `triggered_by` input to the existing `workflow_dispatch` trigger (defaults to `"manual"` for humans using the GitHub UI; the API sends `"submit"`).
- `scripts/ingest.js` — `--triggered-by` now accepts `"submit"` alongside the existing `"cron"`/`"manual"`.
- `packages/core/src/db/queries.ts` — added `getTotalRepoCount()`, distinct from the existing `getIndexedRepoCount()` (which counts only `status: 'complete'` — the public-facing "N repos indexed" stat, not what the submission cap actually limits).

**Two new secrets, not yet set anywhere — flagged per the project's own "new secret is a decision point" rule:**

- `GH_DISPATCH_TOKEN` — a GitHub PAT (fine-grained, scoped to just this repo, `actions: write`) for triggering `workflow_dispatch` from Vercel. Distinct from the auto-injected `GITHUB_TOKEN` used inside the workflow itself, which is only valid during that run and can't be used from an external process.
- `GH_REPO` — `"owner/name"` for deptend.dev's own GitHub repo (not the submitted target repo). Needed because this project only knows Mico's GitHub username from context, not the exact repo slug with certainty.

Both need to be added to `.env.local` and to Vercel's environment variables once Phase 3 deploys.

## Consequences

- Verified from a clean state (`rm -rf` every `dist`/`.next`): `typecheck`, `test` (197/197, unchanged), `build`, `lint`, `format:check` — all exit 0, including a `next build` with every new env var (`GH_DISPATCH_TOKEN`, `GH_REPO`, plus every existing auth/DB var) intentionally unset, confirming nothing throws at build/module-eval time.
- Not verified: an actual `workflow_dispatch` call against a real token/repo — no valid `GH_DISPATCH_TOKEN` exists yet to test against, and this was written without guessing at or probing Mico's real repository. First real test happens once the two new secrets are set.
- `noUncheckedIndexedAccess` (already enabled project-wide) caught three real gaps on the first pass in `repos.ts` — regex capture groups and array-destructured query results are `T | undefined`, not `T`, even when a human can see the value must be present. All three fixed with explicit checks rather than non-null assertions, consistent with how this project has handled every other instance of this class of TypeScript strictness throughout Phase 1–3.

## Free-tier compliance

`GH_DISPATCH_TOKEN` is a GitHub PAT — free, same as every other GitHub credential this project uses. No paid service, no new third-party account.
