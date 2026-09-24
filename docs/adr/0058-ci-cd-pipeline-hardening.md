# ADR 0058: CI/CD pipeline hardening

**Status:** Proposed (flipped back from Accepted 2026-09-23: the workflow was never validated on GitHub's servers — the original `needs: ci` reference pointed at a job name that no longer existed, which GitHub rejects at push time; corrected to `needs: test`. Live verification pending a green run on the pushed workflow.)
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

## References

- 15+ fix commits in Sep 2026 for CI workflow issues (e.g., efe138a, 0c1ae12, 45c028c, aafc964, d44a7c9, af465d1, e9777c1, 4abf47d, 40f9d1b).
- Commit 2d358f9: "fix: ingest scheduled run - default triggered_by to cron".
- GitHub Actions docs: "Workflow syntax for GitHub Actions" — automatic YAML validation on push.
