# TASK-04 — Implement ADR 0044's Decision 1: core `dependencies` block (never shipped)

**Agent:** opencode · **Priority:** high (docs-vs-source drift on an Accepted ADR)
**Area:** `packages/core/package.json`, root `package.json`, `pnpm-lock.yaml`,
`AGENTS.md` §12, `docs/data-model/README.md` (if it claims the same), `CHANGELOG.md`

## Evidence (git archaeology, 2026-09-25)

ADR 0044 (Accepted, 2026-08-29) Decision 1 says `packages/core/package.json` gains a
`dependencies` block listing the six packages core imports. **It was never implemented:**

```
grep -c '"dependencies"' → 0 occurrences in:
  - packages/core/package.json at HEAD
  - the same file at c32878f (the commit that accepted ADR 0044)
  - the same file at 87a8f04 (the last commit touching the file)
```

Zero occurrences across the entire git history of the file. Meanwhile AGENTS.md §12
claims "packages/core/package.json declares its own runtime dependencies block (six
packages)" — **stale since the ADR was accepted**; the exact §0.1 drift pattern this
repo documents. ADR 0047 (Accepted) repeats the same claim ("move packages/core's six
runtime dependencies out of root hoisting and into packages/core/package.json"), also
never implemented. ADR 0044's Verification section claims the empirical test passed —
**uncorroborated**: the test cannot have passed against a manifest that doesn't have the
block (per the ADR's own Context section, removing root's deps fails core's build with
26 TS2307 errors _because_ core has no block of its own).

Also in scope (same ADR, same drift): **Decision 2** — remove the unused
`drizzle-orm` / `@neondatabase/serverless` from `app/package.json`. Verified 2026-09-25:
`app/src/` has zero direct imports of either package (searched `*.{ts,tsx}` for
`@neondatabase/serverless` and `from "drizzle-orm"` — 0 matches; `app/src/lib/db.ts`
only imports `createReadonlyDb` from `@deptend/core/db/queries.js`). Decision 2's
premise holds; it too was never implemented.

## Known constraints (binding)

- This task **implements an already-Accepted ADR** — no new ADR needed, no decision
  point. Cite ADR 0044 in the CHANGELOG entry and code comments.
- **ADR 0044 Decision 1's exact shape:** `packages/core/package.json` gains
  `"dependencies": { "@neondatabase/serverless": "^1.1.0", "@renovatebot/pep440":
"^5.0.0", "@yarnpkg/lockfile": "^1.0.0", "drizzle-orm": "^0.45.2", "semver":
"^7.8.5", "smol-toml": "^1.7.0" }` — matching root's block exactly (except smol-toml:
  if TASK-03 already bumped it to `^1.7.1`, use `^1.7.1` in BOTH blocks).
- Root's `dependencies` block **stays** (it's `scripts/ingest.js`'s only resolution
  path — ADR 0044 Decision 1, reasons 1–2). Both stay in lockstep.
- `app/package.json` loses `drizzle-orm` and `@neondatabase/serverless` (Decision 2).
  **Verify first** that no `/app` source file imports them (the search above was run on
  2026-09-25 and found zero matches; re-run it to be sure — `app/src/lib/db.ts` is the
  file to check, it imports only from `@deptend/core`).
- **The empirical test is the acceptance check** (ADR 0044's own Verification section):
  after the change, `packages/core`'s build must succeed from a state where root's
  `dependencies` block is temporarily removed. That is the test ADR 0044 says proves
  the fragility closed. Run it: temporarily comment out root's `dependencies`, run
  `pnpm install` and `pnpm --filter @deptend/core build` from a clean state, confirm
  clean dist/, then restore root's block and re-run `pnpm install`.
- **TASK-03 interaction:** if TASK-03 ran first, `pnpm-workspace.yaml` now owns the
  `overrides` block (sharp bumped to `^0.35.4`) and root's `pnpm` field is gone. This
  task must not reintroduce root's `pnpm` field. If this task runs first, leave
  `pnpm.overrides` where it is (TASK-03 will move it).
- Per AGENTS.md §0.6, load `.opencode/skills/actually-code` before writing code.

## What to do

1. **Add the `dependencies` block to `packages/core/package.json`** per the exact shape
   above (versions matching root, or TASK-03's bumped smol-toml in both).
2. **Remove `drizzle-orm` and `@neondatabase/serverless` from `app/package.json`** (Decision 2).
3. **`pnpm install`** to update `pnpm-lock.yaml`.
4. **Run ADR 0044's empirical test**: comment out root's `dependencies` block, `pnpm
install` from a clean state, `pnpm --filter @deptend/core build` — must succeed with
   a clean `dist/` (this is the acceptance check the ADR claims but never ran).
   Restore root's block afterward and `pnpm install` again.
5. **Update AGENTS.md §12** (the "Workspace manifests" bullet) and any other doc that
   claims the block already exists — the claim is stale; the block now actually
   exists. Also check `docs/data-model/README.md` and CHANGELOG for the same claim.
6. **Full §6 gate.**

## Do NOT

- Do not delete root's `dependencies` block permanently (breaks `scripts/ingest.js` —
  ADR 0044 Decision 1 reason 2; the temporary removal is ONLY the empirical test).
- Do not touch `packages/core`'s `devDependencies` (correctly scoped per ADR 0044
  Decision 3).
- Do not edit ADR 0044 itself (it's Accepted; the implementation is this task's
  deliverable — if you want to add a verification-evidence note, append it in the same
  PR, don't rewrite the ADR).

## Verification gate (run in this order before claiming done)

```bash
pnpm run typecheck && pnpm -r test && pnpm run build && pnpm run lint && pnpm run format:check
```

Plus ADR 0044's empirical test (step 4) passing, and `grep -c '"dependencies"'
packages/core/package.json` returning 1.
