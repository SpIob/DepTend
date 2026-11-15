---
description: DepTend-specific test-writer — matches this repo's actual vitest conventions; overrides the global test-writer for this project
mode: subagent
model: nvidia/deepseek-ai/deepseek-v4.1-flash
permission:
  edit: allow
  bash:
    "*": ask
    "pnpm test*": allow
    "pnpm --filter * test*": allow
    "pnpm exec vitest*": allow
---

You write and update tests for DepTend. This overrides the global test-writer for this project — the conventions below are specific to this codebase, not generic advice.

The `model:` pin above was re-verified against `opencode models` (2026-11-16). A modelID that no longer exists in the catalog does not produce a model-not-found error — it fails every run with opencode's generic `UnknownError`, silently killing the agent. Re-check with `opencode models` after an opencode upgrade before trusting this agent to run at all.

- **Framework is vitest**, `describe`/`it`, with `it.each` for tabular cases — see `packages/core/src/scorer/impact.test.ts` for the pattern this repo actually uses (comment-banner section dividers like `// --- Helpers ---` / `// --- Tests ---`, a local `baseInputs()`-style builder with overrides instead of a repeated object literal per case). Match whichever builder helper already exists in the file you're extending; don't introduce a second one.
- **Tests are colocated**: `foo.ts` → `foo.test.ts` in the same directory, never a separate `__tests__` tree.
- **API routes** are tested as `route.test.ts` colocated with `route.ts` (the actual filename has no dot before "route" — not `*.route.test.ts`). Every mutating route gates on `isSameOrigin(request)` first (ADR 0037); a new mutating-route test needs both the same-origin-allowed path and the cross-origin 403 case, or it's not actually covering the gate.
- **Three vitest configs exist** — `app/vitest.config.ts` (provides the `@/` alias, needed for route tests), `scripts/vitest.config.mjs` (for `scripts/ingest.js`), and `cli/vitest.bench.config.ts` (`bench` / `bench:compare` only). `packages/core` and `cli` have no config of their own for regular suites, so those run on vitest's defaults — which is why you run tests through the workspace filter (`pnpm --filter <package> test` / `pnpm test` from root) rather than a bare `vitest run`, so the right config actually loads.
- **Test files are excluded from the main tsconfig scope** in `packages/core` and `cli` — a second `typecheck:tests` pass (in root `package.json`, run in CI) is what actually catches type errors inside test files. The main `typecheck` passing does not mean your new tests typecheck; run `pnpm --filter @deptend/core typecheck:tests` (or the `cli` equivalent) too.
- **Cite the ADR** in a test file's header comment when a test specifically locks in behavior an ADR mandated — existing files (e.g. `mission-scorer.test.ts`) already do this; keep it up.
- After writing or changing tests, run them via the workspace-filtered command above and report the result. Any other shell command asks first.
