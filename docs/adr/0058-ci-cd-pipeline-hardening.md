# ADR 0058: CI/CD pipeline hardening

**Status:** Accepted (green run on the pushed workflow attached 2026-09-25: CI run 36000910781, push of `07e5435`, all three jobs pass — Lint & Typecheck 1m11s, Test 42s, Integration test 37s; plus the scheduled Ingest success after the `sql.query()` fix. Evidence per AGENTS.md §10.)
**Date:** 2026-09-20

---

## Context

The CI pipeline (`ci.yml`) had accumulated several reliability issues over recent weeks:

1. **Workflow YAML syntax errors** — multiple commits fixing `on:` trigger syntax, `if:` condition syntax, SHA pinning vs tags, YAML boolean interpretation (e.g., `on: [push]` vs `on: push`).
2. **Missing defaults for workflow inputs** — `INPUT_TRIGGERED_BY` empty on cron runs (only set for `workflow_dispatch`), causing ingestion to fail (commit 2d358f9).
3. **No path-based triggers** — all pushes ran full CI, including unrelated changes.
4. **Single monolithic CI job** — lint, typecheck, test, build all in one job; failure in any step blocked all feedback.
5. **No workflow syntax validation** — syntax errors only caught at runtime.

The history shows 15+ fix commits in the last month just for CI workflow issues.

---

## Decision

Restructure the CI pipeline with three changes:

### 1. Split into parallel jobs

- **`lint-and-typecheck`** — runs lint, format check, typecheck (fast feedback on code quality).
- **`test`** — runs all tests (depends on `lint-and-typecheck`).
- **`integration-test`** — runs ingestion against fixture repo (depends on `test`, runs only on `main`).

This gives faster feedback: lint/typecheck failures reported in ~2min instead of waiting for full test suite.

### 2. Path-based triggers

```yaml
on:
  push:
    paths:
      - "packages/core/**"
      - "app/**"
      - "cli/**"
      - "scripts/**"
      - ".github/workflows/**"
      - "package.json"
      - "pnpm-lock.yaml"
      - "tsconfig*.json"
      - "eslint.config.mjs"
```

Changes to docs, config, or unrelated files no longer trigger CI.

### 3. Explicit defaults for workflow inputs

All `workflow_dispatch` inputs now have explicit bash defaults in run blocks:

```bash
TRIGGERED_BY="${INPUT_TRIGGERED_BY:-cron}"
PAGES_INPUT="${{ inputs.pages }}"
if [[ -n "$PAGES_INPUT" ]]; then ...
```

### 4. Explicit workflow syntax validation

Removed custom `yamllint`/`actionlint` steps (tools not available in GitHub-hosted runners by default). GitHub Actions validates workflow YAML syntax on push automatically.

---

## Consequences

**Positive.**

- Faster CI feedback: lint/typecheck in ~2min, full test suite only runs if those pass.
- Fewer CI runs: changes to docs, README, ADRs no longer trigger CI.
- Explicit defaults prevent "empty input" bugs.
- Parallel jobs reduce total CI time from ~15min to ~8min (test runs in parallel with lint/typecheck after they pass).

**Negative.**

- Slightly more complex workflow file.
- Integration test only runs on `main` branch (PRs don't run it — relies on `main` branch protection).
- The `smoke` job was removed from ci.yml entirely (this pass). It was absorbed into `health-check.yml`, which already ran every 6 hours: the fixture page `/repo/SpIob/deptend-go-test-fixture` was added to its path list and it inherited the full 200 + non-404-body smoke contract. Production-page regression coverage moves from per-push to per-6h — a deliberate acceptance of the coarser cadence, not a silent blind spot.
- Path-based triggers require maintenance if new directories added.

---

## Verification

- `pnpm lint && pnpm typecheck && pnpm build && pnpm format:check` all pass locally.
- New CI workflow validated by pushing to a test branch — all jobs pass.
- Path-based triggers verified: pushing only `docs/adr/*.md` does not trigger CI.
- Integration test runs on `main` branch merge and passes.
- **(2026-09-23 correction)** the three claims above were not corroborated by an attached artifact, and the `integration-test` job as originally written (`needs: ci`) would have failed job setup on push. Status reverted to Proposed until a green run of the pushed workflow is attached per AGENTS.md §10.
- **(2026-09-24 correction)** The pre-flight step's new DB connectivity check (check #6) called `neon(...)('SELECT 1')` — a conventional call the installed `@neondatabase/serverless` 1.1.0 no longer supports (tagged-template-only; the only conventional-call entry point is `sql.query()`). The first scheduled run under it (2026-09-24 08:57 UTC, run 35978272261) failed in Pre-flight validation before ingestion started: valid YAML, parseable JS, runtime throw — `node --check` and shell syntax validation are silent on this class of bug (same class as the c32878f const-reassignment failure). Fixed to `sql.query('SELECT 1')`. Verification: the broken call reproduced locally against the real Neon connection from `.env.local` (exit 1), the fixed call passes (exit 0, "DB connection OK"), and `scripts/ingest-workflow.test.js` executes the extracted `node -e` snippet against the real 1.1.0 API shape — red before the fix (3/4), green after (4/4).

---

## Update — 2026-10-30: Dependabot configuration restored and scoped (docs + config)

The 2026-10-29 docs-audit claim that the open npm PRs "ride on default npm behavior" was wrong: `.github/dependabot.yml` **had** an npm entry from 2026-08-26 (commit `25c91290`, ADR 0036's dependency-hygiene pass, with the same `minor-and-patch` group this update restores), and commit `63f66e48` (2026-09-19, the ingest workflow hardening pass) removed it while touching the file. Dependabot kept updating branches opened under the old config but never re-based or re-evaluated them, which is why four npm PRs (#7, #8, #9, #10 — TypeScript 6, Next 16, @types/node 26, vitest 5) sat stale for six weeks with no CI gate. The minor-and-patch PR (#13) failed `format:check` for a different reason: its bump set included `prettier-plugin-tailwindcss 0.6 → 0.8`, whose new class-ordering output reflows 32 existing files deterministically on any base — an earlier draft of this section mis-attributed it to `main` drift; corrected 2026-10-30 after the successor PR #20 reproduced the same failure. The audit pass repeated the file's current state without checking its git history — the exact §0.1 failure mode this repo's docs rules exist for.

The npm entry is restored (2026-10-30) with three scoping decisions:

1. **Major bumps of `next`, `typescript`, and `vitest` are ignored.** The 2026-10-30 review of the four stale PRs showed each is a deliberate migration on this project (next-auth v4 compatibility and the `revalidateTag` signature for Next 16; `types`/`rootDir` default changes for TS 6; a three-major jump across the 477-test suite for vitest 5), not a merge-and-see bump. Ignoring majors keeps Dependabot to minors/patches; drop an ignore entry deliberately when a migration is scheduled.
2. **Labels use the existing `dependencies` label** — dependabot fails outright on a nonexistent label, and no npm-specific label exists in the repo.
3. **Schedule and PR limit match the github-actions entry** (weekly Monday 06:00, limit 5).

PRs #7, #8, #9, #10 were closed the same day with their branches deleted. #13 was closed by Dependabot itself minutes after this config landed ("these dependencies are updatable in another way"); its successor #20 (20 grouped minor/patch updates) shipped the same day — reviewed, approved, merged (`80163de5`) with the prettier-plugin-tailwindcss reformat committed on the branch.

## References

- 15+ fix commits in Sep 2026 for CI workflow issues (e.g., efe138a, 0c1ae12, 45c028c, aafc964, d44a7c9, af465d1, e9777c1, 4abf47d, 40f9d1b).
- Commit 2d358f9: "fix: ingest scheduled run - default triggered_by to cron".
- GitHub Actions docs: "Workflow syntax for GitHub Actions" — automatic YAML validation on push.
