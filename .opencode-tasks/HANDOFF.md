# HANDOFF — DepTend autonomous fix/improvement pass (2026-09-25)

## Why this directory exists

Mico asked for a bug-fix/improvement pass with each task assigned to OpenCode, requiring
no permissions from him. The OpenCode part hit a hard blocker while he was away: **every
`opencode` CLI invocation requires an interactive approval from Mico's side** (3 attempts
on 2026-09-25 each sat in the 5-minute approval queue and timed out — even a trivial
smoke-test prompt). So the audit below was completed with Hermes' own tools (read-only),
and every task OpenCode should run is staged here as a drop-in task file.

## What was audited (all read-only, evidence cited per task)

- Full §6 verification gate on HEAD `07e5435`: typecheck ✓ · test ✓ (all workspaces; app
  218 tests / 21 files) · build ✓ · lint `--max-warnings 0` ✓ · format:check ✓ ·
  both `tsconfig.eslint.json` passes ✓.
- Production live checks: `/` 200, `/missions` 200, `/org/SpIob` 200,
  `/repo/SpIob/deptend-go-test-fixture` 200, `/api/bogus` 404 + JSON envelope,
  `/missions?page=999` renders a full 27.9 kB board (last page, no empty flash).
- GitHub Actions: CI green (run 36000910781, all 3 jobs); Ingest green after the
  2026-09-24 `sql.query()` fix; **Weekly perf audit failing** (see TASK-01).
- Vercel env (read via MCP): `GITHUB_TOKEN` IS set for production — AGENTS.md §13's
  "flagged as absent" is stale. `UPSTASH_REDIS_REST_*` and `LIBRARIES_IO_API_KEY` are
  absent (known/flagged decision points, not touched).
- Neon (read via MCP): all 8 migrations 0001–0008 are applied on production — including
  0005 (`idx_dependencies_repo_ecosystem`). §13's "production still needs drizzle-kit
  migrate for 0005" is stale/closed.
- Source: `pnpm audit --prod` finds **6 vulnerabilities (4 high)** — TASK-03.
  `rate-limit-redis.ts` initializes at module load with a sticky fallback and no error
  handling on the Redis call — TASK-02. `packages/core/package.json` has no
  `dependencies` block anywhere in git history while ADR 0044 (Accepted) claims it does —
  TASK-04. Home page `/` perf regressed run-over-run (LCP 2337→3224 ms, score 76→59) —
  TASK-01.

## How to run (one interactive session, back at the desk)

```bash
cd "/Users/spiob/Coding Projects/DepTend/Source"
bash .opencode-tasks/run-all.sh
```

- Runs the five tasks **sequentially** (they touch overlapping files: CHANGELOG.md,
  package.json/lockfile — §0a's high-conflict set).
- Expect **up to 5 approval prompts** (one per OpenCode invocation) unless the approval
  gate auto-allows after the first.
- Uses the nvm OpenCode binary explicitly (`~/.nvm/versions/node/v22.23.1/bin/opencode`);
  the homebrew install (`/opt/homebrew/bin/opencode`, 1.15.13) is stale and crashes on
  the shared storage schema — do not let PATH pick it.
- Each task loads the repo-local `actually-code` skill (`.opencode/skills/actually-code`)
  per AGENTS.md §0.6.
- The runner re-runs the full §6 gate at the end and prints a summary.

## What is NOT in scope (decision points for Mico, flagged not resolved)

- **Merging the three open dependabot PRs** (#13 minor-and-patch group, #14
  upload-artifact→7.0.1, #16 dawidd6/action-send-mail 3→22) — auto-deploys to `main` on
  merge; that's a deploy-window decision, not an autonomous one.
- **Upstash account creation** for the Redis rate limiter (ADR 0056) — needs an account
  signup + secrets; production currently runs the in-memory fallback (single-instance,
  per cold start). Zero-budget compliant (free tier) but a decision point per §0.3.
- **`LIBRARIES_IO_API_KEY`** for the downstream-dependents prefetch (ADR 0032) — free
  tier, account signup; absent ⇒ missions keep the flag set. Decision point, not touched.
- **`pnpm audit --prod`'s `cli` advisory (GHSA-6cpc-mj5c-m9rq, low)** — false positive:
  `pnpm why cli` shows no installed package and empty paths; it's a registry advisory
  name-collision with an unpublished package name. Documented in TASK-05; not "fixed."
- **The perf thresholds themselves** (LCP 2500 ms / score 80, relaxed in b21a121) — the
  fix must make the page pass the real thresholds, not move them. TASK-01 explicitly
  forbids threshold-gaming.
- **The `awesome-*` list-submission block**, the 51 MB demo GIF in git history, and the
  npm-side `inferSemverBump` upper-bound inconsistency — settled/known per §11/§13.

## Verification status of this pass

Audit-only (no code changed by Hermes while away). Every task file carries its own
verification steps; the runner's final gate is the acceptance check. Nothing here has
been claimed as "shipped" — nothing ships until OpenCode runs and the gate passes.
