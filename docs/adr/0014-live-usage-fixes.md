# ADR 0014 — Live-Usage Fixes: Dev Build Ordering, Workflow Dispatch Inputs, Lint-Staged Warnings

**Status:** Accepted
**Date:** 2026-07-10
**Phase:** 3 (repo submission, first real end-to-end run)

---

## Context

Same pattern as ADR 0009/0010: bugs invisible to `typecheck`/`test`/`build`/`lint`/`format:check` because none of those five checks exercise the surface where the bug lives. Different this time — Mico found, diagnosed, and fixed all three directly, against real infrastructure this project's sandbox verification structurally cannot reach: an actual interactive `next dev` session, an actual `git commit` through the real Husky hook, and an actual `workflow_dispatch` call against GitHub's live API with a real token. All three are accepted here as reported, not independently re-derived.

### 1. `pnpm --filter app dev` failed: `packages/core`'s dist was stale

ADR 0012 fixed `pnpm typecheck`'s build ordering (`pnpm --filter @deptend/core build && pnpm -r typecheck`) after finding `app`'s typecheck depends on `packages/core/dist/*.d.ts` existing. The same dependency exists for `next dev` — `/app` imports `@deptend/core` through its compiled `exports`, not source — but the `dev` script was never given the same treatment, because at the time ADR 0012 was written `/app` didn't yet import anything from a version of `@deptend/core` that had changed since the last build. `db/repos.ts` (Phase 3's repo-submission work) was the first time a whole new module was added to `packages/core` without a `packages/core` rebuild happening in between — `dist/db/repos.js` simply didn't exist yet, so `next dev`'s module resolution failed outright, and `queries.ts`'s newly-added `getTotalRepoCount` export was similarly missing from the stale `dist/db/queries.js`.

Separately, `packages/core`'s `build` script (`tsc --project tsconfig.json`) never cleaned `dist/` first — `tsc` doesn't delete output for source files that no longer exist, so `dist/db/types.js`/`.d.ts` was still sitting there, unreferenced, ever since `db/types.ts` was deleted in ADR 0011. Harmless on its own, but the same class of staleness as the missing `repos.js`, just silent instead of loud.

### 2. Repo submission always fell back to the cron message, never triggered `workflow_dispatch` immediately

`github-dispatch.ts` sends `inputs: { repo_id, triggered_by: "submit" }` to GitHub's dispatches API. GitHub validates that request against whatever `workflow_dispatch.inputs` schema is committed on the **default branch on GitHub's servers** — not against any local working copy, and not against what this project's own sandbox verification checked. If the `ingest.yml` input-schema change from ADR 0013 hadn't yet reached `main` on GitHub at the moment a real submission was tested, the dispatch call would be rejected outright (an extra, undeclared input field), and the API route's best-effort fallback (still succeeds — see ADR 0013) would silently mask the failure as "will be processed on the next scheduled run."

This is a category of bug no automated check in this project can catch: it's a drift between local files and GitHub's server-side copy of a workflow definition, which only exists once something is pushed. **Operational rule going forward: any change to a `workflow_dispatch.inputs` schema must be committed and pushed to `main` before testing a dispatch call against it** — `git push` is now effectively part of the verification loop for this specific class of change, the same way `pnpm build` became part of it for `packages/core` consumers in ADR 0012.

### 3. `git commit` blocked by Husky/lint-staged on `app/next-env.d.ts`

ADR 0012 added `next-env.d.ts` to ESLint's global `ignores` (it's Next.js's auto-generated file, never meant to be hand-edited). `pnpm lint` (`eslint . --max-warnings 0`, letting ESLint discover files itself) respects that silently. `lint-staged`, wired into the pre-commit hook, works differently — it passes the _exact staged file paths_ to ESLint explicitly, and ESLint 9 emits a warning (not a silent skip) whenever a file passed explicitly on the command line matches an ignore pattern. With `--max-warnings 0`, that warning becomes a hard failure. This wasn't caught because `pnpm lint` and `lint-staged`'s invocation of ESLint are two different code paths through the same tool, and only one of them was exercised by this project's standard verification loop.

## Decision

Fixed as reported:

- **`app/package.json`**: added `"predev": "pnpm --filter @deptend/core build"`. pnpm runs `pre*` lifecycle scripts automatically before the matching script, for any invocation path (`pnpm --filter app dev` directly, or via a root-level `dev` script) — confirmed by deleting `packages/core/dist` and observing the core build run to completion before `next dev` started.
- **`packages/core/package.json`**: `"build": "rm -rf dist && tsc --project tsconfig.json"` — a clean build every time closes the stale-output class of bug generally, not just for this one instance.
- **`.github/workflows/ingest.yml`**: `workflow_dispatch.inputs` gained `triggered_by` (`type: string`, `default: "manual"`), and the "Run ingestion" step now passes `--triggered-by "${{ inputs.triggered_by }}"` instead of a hardcoded `manual`, for the `repo_id`-present branch. (This project's own sandbox copy already had this exact change from ADR 0013's original delivery — the discrepancy Mico hit was almost certainly the push-timing issue described above, not a content gap. Recorded here regardless, since the operational lesson is the actual point.)
- **Root `package.json`**, `lint-staged` config: `eslint --max-warnings 0 --fix` → `eslint --max-warnings 0 --no-warn-ignored --fix` for the `*.{ts,tsx,js,mjs,cjs}` glob.

## Consequences

- Verified independently where this project's sandbox can reach: `predev` triggering confirmed by deleting `dist/` and watching `pnpm --filter app dev`'s output show the core build completing before `next dev` starts; the clean-build change confirmed by checking `dist/db/` afterward for the absence of any file with no corresponding `src/` source; the lint-staged fix reproduced exactly (`eslint --max-warnings 0 --fix app/next-env.d.ts` fails with the same warning Mico saw; adding `--no-warn-ignored` fixes it). All three, plus a full `typecheck`/`test`/`build`/`lint`/`format:check` pass, done from a fully clean state.
- **Not independently verified, and structurally can't be from here:** the `workflow_dispatch` fix itself. Confirmed working only by Mico's own report — a real submission, a real `Ingest` run appearing in the repo's Actions tab, real missions rendering afterward. This is the actual end-to-end proof the whole Phase 3 pipeline has been building toward.
- Same lesson as ADR 0012, extended: this project's five standard checks (`typecheck`, `test`, `build`, `lint`, `format:check`) cover everything that can be checked from a single machine with no live GitHub/DB state. They structurally cannot cover interactive dev-server behavior, real pre-commit hook invocation, or GitHub's server-side view of a workflow file. Those needed a human actually running the thing.

## Free-tier compliance

No new dependency, no new service. Tooling and workflow configuration only.
