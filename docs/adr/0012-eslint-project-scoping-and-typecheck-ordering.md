# ADR 0012 — ESLint Multi-Project Type Identity, and Typecheck Build Ordering

**Status:** Accepted
**Date:** 2026-07-09
**Phase:** 3 (mission list rendering)

---

## Context

Building `/app`'s mission list page was the first time any app code actually consumed `@deptend/core` beyond a placeholder. Two latent problems surfaced that had no way to show up before this point, because nothing had exercised the relevant paths.

### 1. ESLint's typed linting silently broke on any Drizzle query result touched from `/app`

Symptom, bisected down to the smallest possible repro: `db.select().from(missions)` — a single table, no join, no column aliasing — followed by `rows.map((row) => row.id)`, inside a file under `app/src/`, produced `@typescript-eslint/no-unsafe-assignment` / `no-unsafe-return` against an unresolvable `error` type. `tsc --noEmit` never saw this. Identity-mapping the same rows (`rows.map((row) => row)`, no property access) was fine; the moment a property was read off a row, it broke — for any join shape, any select shape, even the most trivial one.

Root cause: `eslint.config.mjs`'s typed-linting block listed all four workspace tsconfigs in a single `parserOptions.project` array (`tsconfig.base.json`, `app/tsconfig.json`, `cli/tsconfig.json`, `packages/core/tsconfig.json`) applied uniformly to `**/*.ts`/`**/*.tsx`. In that configuration, a file under `app/src/` gets type information from a program that also has `packages/core/tsconfig.json` in scope — which independently compiles `packages/core/src/db/schema.ts` from source. Meanwhile `app`'s own module resolution reaches the same table objects through `@deptend/core`'s package `exports`, i.e. the _compiled_ `dist/db/schema.d.ts`. Both are structurally identical, but they are two separate compilations of the same declaration, and Drizzle's table/column types rely on internal brand fields for their generic machinery (which column belongs to which table, nullability through joins, etc.). Structurally-identical-but-separately-compiled brands don't unify, so any expression that made ESLint's checker actually resolve a field on a joined row degraded to `error`. A plain `tsc --noEmit` run never hit this because it only ever loads one tsconfig's program at a time.

This is a general problem, not specific to the mission query — it would have hit the very next Drizzle-touching code written in `/app`, for auth or repo submission, just as easily.

### 2. `app`'s typecheck now genuinely depends on `packages/core`'s _build_, not just its typecheck

Once `/app` imports `@deptend/core/db/queries.js` and the `@deptend/core` barrel, `app`'s `tsc --noEmit` needs `packages/core/dist/*.d.ts` to exist (that's what the package's `exports` field points at). `pnpm typecheck` runs `tsc --noEmit` per package — which by definition never writes anything to disk. So `pnpm typecheck` run standalone on a checkout where `packages/core/dist/` doesn't yet exist (a fresh clone, or after any clean) fails for `app`, regardless of execution order, because nothing in that command chain ever builds `packages/core`. This wasn't a problem before because `/app` never imported anything from `@deptend/core`.

`.github/workflows/ci.yml` already runs `pnpm --filter @deptend/core build` before its Typecheck step — CI was unaffected. The standing local dev sequence (`pnpm typecheck` first, standalone) was not.

## Decision

**ESLint:** scope typed linting per workspace package instead of one shared `project` array. Four blocks, each matched by that package's own file glob and pointing at only that package's tsconfig: `app/**/*.{ts,tsx}` → `app/tsconfig.json`; `cli/**/*.ts` → `cli/tsconfig.json`; `packages/core/**/*.ts` → a new `packages/core/tsconfig.eslint.json`; root-level `*.ts` (e.g. `drizzle.config.ts`) → `tsconfig.base.json` + `tsconfig.json`. A file is now only ever type-checked, for lint purposes, against the one program that actually owns it.

`packages/core/tsconfig.eslint.json` is new and lint-only — `extends: "./tsconfig.json"` but with `include`/`exclude` overridden to drop the `**/*.test.ts` exclusion. The real `tsconfig.json` (used by `tsc --noEmit` and the build) still excludes test files from the shipped package on purpose; ESLint's typed rules still need to see them (this is exactly what caught the four stale `db/types.js` imports during ADR 0011 — that behavior had to be preserved, not just made to pass).

Two small side effects of the split, both fixed in the same pass: `app/next-env.d.ts` (Next.js's auto-generated file, matched by `app/tsconfig.json`'s own `include`) started being linted for the first time and hit `@typescript-eslint/triple-slash-reference` — added to ESLint's global `ignores`, since it's machine-generated and never meant to be hand-edited. One real (small, pre-existing-style) bug this surfaced on the first pass: a `number` interpolated directly into a template literal in `mission-card.tsx`, disallowed under `restrictTemplateExpressions` — fixed with an explicit `.toString()`.

**Typecheck ordering:** root `package.json`'s `typecheck` script becomes `pnpm --filter @deptend/core build && pnpm -r typecheck`, mirroring what CI already did. `pnpm build` and `pnpm test` were already fine as-is (`build` builds core first as part of `pnpm -r build`'s topological ordering; `test` doesn't touch `@deptend/core`'s compiled output at all, only its own source via Vitest).

## Consequences

- `eslint.config.mjs`: four scoped blocks replace the one shared block; a `sharedTsRules` constant holds the rule set common to all four so it's declared once.
- `packages/core/tsconfig.eslint.json`: new, lint-only.
- `package.json`: `typecheck` script now builds `@deptend/core` first.
- `mission-card.tsx`: one `.toString()` fix, unrelated to the config change itself but caught by it.
- No change to `tsc --noEmit`, `tsc --project` builds, or `vitest` — all three were already correct; only ESLint's cross-project type resolution and the typecheck script's build ordering needed fixing.
- Verified end-to-end from a fully clean state (`rm -rf packages/core/dist app/.next cli/dist`), running `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm lint`, `pnpm format:check` in that exact order — the same sequence and order used throughout this project. All five pass with exit code 0. 197/197 tests, unchanged.
- Same lesson as ADR 0009/0010, different layer: the four standard checks each cover different ground, and a monorepo's cross-package boundaries are exactly where that stops being theoretical. This is the second time in two ADRs that `eslint --max-warnings 0` caught something the other three checks structurally cannot.

## Free-tier compliance

No new dependency, no new service. Tooling configuration only.
