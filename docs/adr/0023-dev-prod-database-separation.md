# ADR 0023; Dev/Prod Database Separation via Neon Branching

**Status:** Accepted
**Date:** 2026-07-25
**Phase:** 6 → 7 transition (operational fix, not itself Phase 7 scope)

---

## Context

Local development and production have shared a single Neon database since Phase 0; `app/.env.local`'s `DATABASE_URL`/`DATABASE_URL_UNPOOLED` and Vercel's Production environment variables have always pointed at the same connection string. This was never flagged as a problem through Phase 5, because the repos submitted during local testing were the same handful of real public repos (`SpIob/StockWatch`, the PyPI test fixture, etc.) that also served as the project's only production test data; the two data sets happened to coincide.

It became a real problem once the mission board started being treated as genuinely public-facing: any repo submitted from `localhost:3000`; including throwaway test submissions with no lasting value to a real visitor; persists permanently in the same `repos` table that `deptend.vercel.app`'s public, no-login mission board reads from. `getBoardMissionsWithScores()` (`packages/core/src/db/queries.ts`) has no environment distinction of any kind; it queries every `open`/`claimed` mission across every repo, full stop.

Raised by Mico directly: repos submitted locally were appearing on the live board, indistinguishable from intentional submissions.

## Decision

Use Neon's built-in branching (free, copy-on-write, zero schema/code change) to separate environments, rather than adding environment-tagging or filtering logic to the app itself:

- Local development points `DATABASE_URL` / `DATABASE_URL_UNPOOLED` at a **dedicated Neon branch** (e.g. `dev`), created off the existing project.
- Vercel's Production environment variables are unchanged; still pointing at the original branch, which is now the sole source `deptend.vercel.app` reads from.
- `.env.example` updated with a comment explaining this; no new variable names, just a different branch's connection strings locally.
- **No application code changes.** This is a connection-string/config decision, not a query-filtering one.

### Why branching over the alternatives considered

- **A second free Neon project**, instead of a branch of the existing one: rejected. Functionally equivalent, but a branch is copy-on-write against the parent's existing storage, staying well inside the 0.5GB/project free-tier allowance rather than provisioning a second independent allowance.
- **An `environment` column + query filtering in `packages/core`**: rejected. Would require threading and checking an extra flag through every read/write path (`IngestionWriter`, `MissionWriter`, `queries.ts`, `repos.ts`, `scripts/ingest.js`, the CLI) to solve a problem branching already solves with zero code and zero migration.
- **A separate Vercel Preview-environment branch**: out of scope here. Not needed to solve the immediate problem, and moot in practice today; repo submission requires GitHub OAuth sign-in, which (per ADR 0015) doesn't round-trip correctly on Vercel's per-deployment preview URLs anyway, so preview deployments aren't a realistic pollution vector right now. Worth a second look only if that changes.

### Existing polluted data

Branching only stops **future** leakage; it does not retroactively remove the test/throwaway repos already sitting in the production branch from prior local testing. Cleanup there is a manual, one-time step: query `repos` on the production branch, identify what's actually a real submission versus dev-only test data, and delete the rest by `github_url`. Every dependent table cascades correctly (`ON DELETE CASCADE` on `dependencies.repo_id`, `missions.repo_id`, `ingestion_runs.repo_id`, and `dependency_advisories`/`mission_scores` cascade from those in turn); `advisories` rows are shared/global across repos and are correctly left untouched. No schema change needed; this is a judgment call each time, not an automated rule.

## Consequences

- Any repo submitted from `localhost:3000` from now on is invisible to `deptend.vercel.app` and to anyone browsing it. Not yet independently re-verified by Mico against the real Neon console/Vercel deploy; flagged, not assumed.
- The `dev` branch will drift from production's schema unless migrations are applied to both going forward; worth remembering next time a schema migration ships, given Phase 5's and Phase 6's own migration-tooling hurdles (ADR 0021, ADR 0022) already showed `drizzle-kit migrate` has real quirks in this project even against one branch.
- The public, no-login mission board itself is **unchanged** by this ADR; see "Related decision, declined" below.

## Related decision, declined

Also raised this round: making `repos`/`missions` visible only to the GitHub user who submitted them (true per-submitter privacy), instead of the shared board every visitor currently sees. **Declined by Mico**; the shared public board stays as originally designed (Project Plan §1; Phase 3's "publicly accessible, no login required" exit criterion; ADR 0019's decision to show claimed missions, not hide them, "so the board also answers what's being worked on"). Recorded here rather than silently dropped: making missions private per-submitter would mean auth-gating the entire page, moving the repo cap and the `github_url` uniqueness constraint from global to per-user, and reconsidering what "claiming a mission" means if repos aren't shared; a materially different product, not a small change, and not something to revisit without its own ADR and explicit sign-off.

## Free-tier compliance

No new cost. Neon branching is included free; up to 10 branches per project, no credit card required, copy-on-write so it doesn't meaningfully touch the 0.5GB storage allowance (verified against Neon's current pricing page, 2026-07). No new service, no new dependency, no schema migration.

## Addendum (same day); the on-demand dispatch path was missed

This ADR's original text only accounted for two of the three places `DATABASE_URL` is configured; `app/.env.local` and Vercel's Production environment variables. There's a third: **GitHub Actions repository secrets**, which `.github/workflows/ingest.yml` reads via `${{ secrets.DATABASE_URL }}` for both the nightly cron and the on-demand `workflow_dispatch` that `POST /api/repos` fires via `triggerIngestion()` (`app/src/lib/github-dispatch.ts`) on every successful submission; including submissions made through a locally-running dev server.

That dispatch is a real, remote GitHub Actions run. It always executes against the Actions secret, which (correctly, per this ADR) still points at production. So: submitting a repo via `pnpm --filter app dev` wrote the new repo row into the `dev` branch, then immediately asked the (production-only) Actions workflow to ingest that same UUID; which doesn't exist in production. First symptom hit: `scripts/ingest.js`'s `resolveById()` fails fast with `No repo found in database with id="...". Seed the repo first, or use --repo-url for local testing.`; a clean, harmless failure (confirmed by reading the script: this fatal exit happens before any DB write, including the `ingestion_runs` row that would normally open a run; nothing landed in production from this).

**Fix:** leave `GH_DISPATCH_TOKEN`/`GH_REPO` unset in local `.env.local`. `triggerIngestion()` already treats a missing token/repo as a graceful no-op (`{ ok: false }`, best-effort by original design), so local submission now just creates the row in `dev` and reports "will be processed on the next scheduled run"; inaccurate in the sense that no cron reads the `dev` branch, but harmless. Ingest a locally-submitted repo the way the CLI/manual path was always meant to be used: `node --env-file=.env.local scripts/ingest.js --repo-id <uuid> --triggered-by manual`, run entirely locally against the dev branch, no GitHub Actions involved. `GH_DISPATCH_TOKEN`/`GH_REPO` stay set only in Vercel's Production environment, where the submitter's DB and the workflow's DB are correctly the same branch.

No code change needed for this either; same as the rest of this ADR, purely a local `.env.local` configuration correction. `.env.example` and the README's local dev steps were updated in the same pass.

## Addendum (2026-08-06); a runbook for the still-open cleanup, not the cleanup itself

Roadmap's own Now-list still carries this ADR's "existing polluted data" cleanup as unresolved, alongside a reminder that this ADR's core claim (local submissions invisible to production) hasn't been independently re-verified by Mico either. Neither of those is something that can be closed from here: this project's own network access has no path to the real Neon console, and; more importantly; deciding which rows are "was throwaway local testing" versus "a real, intentionally-kept fixture repo" is exactly the judgment call this ADR's original text already said it has to be, not something to automate. What follows is a reviewable identification query plus a guarded delete template, so that judgment call is easy to make and safe to act on; not an attempt to make it here.

**Cascade chain re-confirmed directly against the live `schema.ts`**, not just trusted from this ADR's original prose: `dependencies.repo_id`, `missions.repo_id`, `ingestion_runs.repo_id`, and `repo_bookmarks.repo_id` (added since this ADR was written, ADR 0027) all carry `onDelete: "cascade"` back to `repos.id`; `dependency_advisories` and `mission_scores` cascade in turn from `dependencies`/`missions`. `advisories` has no `repo_id` at all; it's global, shared by `osv_id` across every repo that happens to depend on the same vulnerable package; so a repo delete correctly leaves it untouched. A single `DELETE FROM repos WHERE id IN (...)` is the complete operation; nothing needs a second pass.

**Step 1; identify, read-only:**

```sql
SELECT
  r.id,
  r.github_url,
  r.submitted_by,
  r.created_at,
  r.ingestion_status,
  COUNT(m.id) AS mission_count
FROM repos r
LEFT JOIN missions m ON m.repo_id = r.id
GROUP BY r.id
ORDER BY r.created_at ASC;
```

Rows older than **2026-07-25** (this ADR's own date) are the real candidates; everything from that date forward was submitted after the branch split existed, so it's either a genuine post-split submission or one of the deliberately-seeded launch repos (Marketing_Plan.md's Week 0 seeding happened July 30, after the cutoff).

**Known false positives to leave alone even if old**; this project's own standing verification fixtures, referenced by name across multiple ADRs and still actively reused, not pollution: anything named `deptend-test-fixture`, `deptend-pypi-test-fixture`, `deptend-nullrepo-test-fixture`, or `SpIob/StockWatch` (Phase 4's CLI-vs-dashboard cross-validation repo). A name match isn't a substitute for actually looking at the row, but it's a reason to slow down before including one in step 2.

**Step 2; delete, only after step 1's output has been read and specific UUIDs chosen by hand:**

```sql
BEGIN;

DELETE FROM repos WHERE id IN (
  '00000000-0000-0000-0000-000000000000' -- replace with real UUIDs from step 1
);

-- Check the reported row count matches the number of UUIDs listed above
-- before committing.

COMMIT; -- or ROLLBACK if anything looks off
```

Deliberately never a date- or pattern-based `WHERE`, even though one would be shorter; an explicit `IN (...)` list is the only form where "did I just delete the wrong thing" is checkable before it's irreversible.

This closes the "no tool exists to do this safely" gap. It does not close the item itself; running Step 1, doing the actual reading, and choosing what belongs in Step 2 is still Mico's call, same as this ADR said on the day it was written.
