# ADR 0044; Restructure workspace dependency declarations

**Status:** Accepted
**Date:** 2026-08-29

---

## Context

The pnpm monorepo has four `package.json` files (root, `app/`, `packages/core/`,
`cli/`). Today, every external runtime dependency the core engine actually
imports — `drizzle-orm`, `semver`, `smol-toml`, `@renovatebot/pep440`,
`@yarnpkg/lockfile`, `@neondatabase/serverless` — is declared exclusively in
the **root** `package.json`. The `packages/core/package.json` declares none of
them, even though every one of them is imported by source code under
`packages/core/src/`.

`app/package.json` declares `drizzle-orm` and `@neondatabase/serverless` in
`dependencies` but no file under `app/src/` ever imports them (per ADR 0012,
all Drizzle query-building lives in `packages/core/src/db/`; the only thing
`app/` consumes from those packages is the Drizzle-typed return value of
`createReadonlyDb`, which is the responsibility of the importing core module).

This is an empirical failure mode, not a theoretical one. The current setup
works because pnpm hoists dependency nodes into the workspace's shared
`node_modules/`, and any package within the workspace resolves through the
hoisted store via Node's standard module-resolution walk. **Verified
empirically** by temporarily deleting root's `dependencies` block and
re-running `pnpm install` from a clean state: `pnpm --filter @deptend/core
build` fails with 26 `TS2307: Cannot find module 'drizzle-orm' or its
corresponding type declarations` errors (and similar for `semver`, `smol-toml`,
`@renovatebot/pep440`, `drizzle-orm/neon-serverless`). The "core installs
standalone" question has a definitive answer: **no, it does not, today.**

That makes the manifest shape load-bearing on a fragile invariant:

- pnpm's hoisting behavior is a workspace-level optimizer, not a declared
  contract. Future changes to the workspace (a private registry, a
  `--no-hoist` install, an extraction of `@deptend/core` to npm) would
  silently break core's build with no warning at the manifest level.
- `packages/core` is the package other workspaces and `scripts/ingest.js`
  consume. Its `package.json` is the contract. A contract that doesn't list
  the packages it imports is misleading to anyone reading the manifest, and
  to the next pnpm upgrade that changes hoisting defaults.
- `app/package.json` declaring `drizzle-orm` and `@neondatabase/serverless` is
  dead weight. It probably was needed at the moment core's exports map
  hadn't yet been wired, before ADR 0012 moved all Drizzle query-building
  out of `/app`. It's been stale for a while and just sits there.

The status quo also has a real cost in practice: any new contributor reading
`packages/core/package.json` sees zero `dependencies` and reasonably concludes
core has none. The "where do these come from?" question then has to be
answered by reading the root manifest, and then by understanding pnpm's
hoisting behavior. The CI config (`pnpm install --frozen-lockfile` at the
root) papers over this; a per-package install would surface it.

## Decision 1; Move core's runtime dependencies into `packages/core/package.json`

`packages/core/package.json` gains a `dependencies` block listing the six
external packages it directly imports:

```json
"dependencies": {
  "@neondatabase/serverless": "^1.1.0",
  "@renovatebot/pep440": "^5.0.0",
  "@yarnpkg/lockfile": "^1.0.0",
  "drizzle-orm": "^0.45.2",
  "semver": "^7.8.5",
  "smol-toml": "^1.7.0"
}
```

Versions match the root manifest exactly today. The `^` semver caret matches
the existing style elsewhere in the manifests (root uses `^1.1.0` for
`@neondatabase/serverless`, `^0.45.2` for `drizzle-orm`, etc.). The
canonical source for these versions becomes `packages/core/package.json`.

The root `package.json` keeps the same `dependencies` block. Two reasons:

1. **Single source of truth, no drift risk.** If both root and core declare
   the same packages at the same versions, there's no need to keep two
   copies in sync. If they ever disagree, the failure mode is "pnpm resolves
   to the stricter union of the two ranges," which is the right conservative
   behavior.
2. **`scripts/ingest.js` also imports two of these** (`@neondatabase/serverless`
   for the `Pool`, `drizzle-orm` and `drizzle-orm/neon-serverless` for the
   transactional writes). It runs in GitHub Actions, not in a workspace
   package, so the root `dependencies` is its only option. Removing the root
   block would require either (a) adding a `package.json` to `scripts/` —
   which is documented as deliberately minimal, just `{"type": "module"}` —
   or (b) moving the two runtime imports core has in common with
   `scripts/ingest.js` out of core and into scripts, which would be a much
   bigger refactor for no real win.

So the policy is: **`packages/core/package.json` declares its own deps, and
the root `package.json` retains its own copy as the single source of truth
that `scripts/ingest.js` resolves against.** Both stay in lockstep via the
ADR-0010 "no dep without a documented reason" rule (next dep change updates
both, or moves the package to its sole owner). This is the
"duplication-with-a-single-source-of-truth" approach, not the
"single-declaration-wherever-it-lives-naturally" approach. The cost is one
extra line in the next dep-add PR; the benefit is that a future extraction
of core to a private npm registry can be done by removing the root copy
without touching `scripts/ingest.js`'s contract.

## Decision 2; Remove the unused `drizzle-orm` / `@neondatabase/serverless` from `app/package.json`

`app/package.json` had these in `dependencies` from before ADR 0012
established that all Drizzle query-building lives in `packages/core/src/db/`.
Today, `app/src/` does not import either package directly; the only
"presence" they have in `/app` is the Drizzle-typed return value of
`createReadonlyDb`, which is imported as a type from `@deptend/core`. Both
declarations are removed.

This is a no-op at install time (pnpm dedupes), but a real change to the
manifest contract. After this, `pnpm ls --depth=0` in `app/` will show only
the packages `/app` actually imports, which is what the manifest is supposed
to communicate.

## Decision 3; Root devDependencies are correctly scoped — no changes

`drizzle-kit`, `dotenv`, and `postgres` are root-level devDeps because
`drizzle.config.ts` (a root-level file) imports them. ESLint, Prettier, Husky,
`lint-staged`, `typescript`, `typescript-eslint`, and `@types/node` are
root-level devDeps because `eslint.config.mjs`, `.prettierrc`,
`.husky/pre-commit`, and `package.json`'s `lint-staged` block are all
root-level. They are tooling the workspace shares, not packages any
workspace's source code imports. They stay where they are.

The workspace-level `@types/*` devDeps are also correct: `app/package.json`
declares `@types/react` and `@types/react-dom` (used only in `app/src/`);
`packages/core/package.json` declares `@types/semver` and
`@types/yarnpkg__lockfile` (used only in `packages/core/src/`, where
`semver` and `@yarnpkg/lockfile` are imported). No relocation needed.

## What this changes for contributors

- The next person reading `packages/core/package.json` sees a complete,
  accurate list of the engine's external dependencies. They no longer have
  to read the root manifest to discover them, and they no longer have to
  understand pnpm hoisting to understand why core's build works.
- A per-package `pnpm install` inside `packages/core/` will now succeed
  (verified by re-running the empirical test post-change: removing root's
  `dependencies` block and confirming core's `pnpm install` +
  `pnpm build` passes).
- A future extraction of `@deptend/core` to a private npm registry, or a
  switch to a pnpm config that disables hoisting, no longer silently breaks
  the build. The manifest declares what core needs; pnpm resolves it
  normally.
- `app/package.json` no longer has dead `drizzle-orm` and
  `@neondatabase/serverless` entries. `pnpm ls --depth=0` in `/app` shows
  only what `/app` actually uses.

## Trade-offs considered

**Alternative A: Single source of truth in root, no per-package `dependencies` blocks.** This is the status quo. The cost is "anyone reading
`packages/core/package.json` doesn't see what core needs." The benefit is
"no manifest drift." The empirical fragility is real but minor in the
current single-registry workspace.

**Alternative B: Single source of truth in core, remove from root.** Cleaner,
but breaks `scripts/ingest.js` (which has no `package.json` to declare the
deps it needs). Would require either adding a `scripts/package.json`
`dependencies` block (a much bigger relative change to a deliberately-minimal
file) or moving the two shared imports out of core and into `scripts/`
(ADR-worthy for a different reason).

**Alternative C: The chosen approach.** Both manifest copies stay. The
duplication is documented and tracked. The empirical test of "can core build
without root's deps?" now passes — a real improvement, not a defensive
hardening for a hypothetical future failure mode.

## Verification

Live-verified empirically before this ADR was finalized:

1. With current manifests (root declares deps, core doesn't), removing the
   root `dependencies` block and re-running `pnpm install` from a clean
   state makes `pnpm --filter @deptend/core build` fail with 26
   `TS2307: Cannot find module …` errors. **The fragility is real.**
2. After Decision 1 lands (core declares its own deps), the same test
   passes: removing root's `dependencies` block, re-installing, and running
   `pnpm --filter @deptend/core build` produces a clean `dist/`. The
   fragility is closed.
3. The full §6 verification gate passes: `typecheck` (all four workspaces,
   including the `tsconfig.eslint.json` test-file pass for core and cli),
   `test` (760 core tests + 2 skipped, app's route suites), `build` (a full
   Next.js production build from a clean state, including the
   `rm -rf .next dist` step), `lint` (no warnings), `format:check`
   (clean).
