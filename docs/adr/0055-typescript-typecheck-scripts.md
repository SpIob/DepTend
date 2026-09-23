# ADR 0055: TypeScript type checking for scripts/ directory

**Status:** Accepted
**Date:** 2026-09-20

---

## Context

The `scripts/` directory contains the ingestion pipeline entry point (`ingest.js`) and supporting modules. Historically this was plain JavaScript with no type checking, relying on the `packages/core` TypeScript build to catch type errors at the boundary. However, several real bugs reached production that would have been caught by TypeScript:

1. **c32878f "Assignment to constant variable"** — `const ghMeta = ghMetaResult.value` reassignment threw at runtime because the destructured `ghMeta` binding was `const`. A `tsc --noEmit` with `checkJs: true` would have caught this at compile time.

2. **Variable shadowing** — `REGISTRY_FETCHERS_BY_ECOSYSTEM` parameter shadowed `githubToken` in the `ingestRepo` call (commit 71292a0), causing the GitHub token to be passed incorrectly.

3. **Dead code** — Unused `registryFetchersByEcosystem` variable in `ingest.js` (commit 1ad3086) went unnoticed.

The existing ESLint config for `scripts/` used `eslint.configs.recommended` but lacked `no-shadow` and `no-const-assign` rules. TypeScript's `checkJs: true` provides a stronger, more comprehensive safety net.

---

## Decision

Add a `scripts/tsconfig.json` with `checkJs: true` and `allowJs: true` to enable TypeScript type checking on the plain JavaScript files in `scripts/`. Key settings:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "checkJs": true,
    "allowJs": true,
    "noEmit": true,
    "rootDir": ".",
    "types": ["node", "vitest/globals"],
    "noImplicitAny": false,
    "exactOptionalPropertyTypes": false
  },
  "include": ["*.js", "*.mjs"],
  "exclude": ["node_modules", "dist", "*.test.js", "*.test.mjs"]
}
```

Key choices:

- `noImplicitAny: false` — the scripts are plain JS and adding JSDoc types everywhere is not worth the maintenance burden; `checkJs: true` still catches structural bugs (shadowing, const reassignment, dead code).
- `exactOptionalPropertyTypes: false` — same rationale; the base config's strictness is relaxed for plain JS.
- Test files excluded — they use mocks heavily and would generate noise.
- Added to root `typecheck` script: `pnpm --filter scripts typecheck`.

ESLint rules `no-shadow` and `no-const-assign` also added to the `scripts/` config for defense in depth.

---

## Consequences

**Positive.**

- Catches the class of bugs that previously reached production (const reassignment, shadowing, dead code) at compile time.
- No new dependencies; uses existing TypeScript toolchain.
- Test files excluded to avoid noise from mock-heavy tests.

**Negative.**

- Slight CI time increase (~300ms for `scripts/` typecheck).
- Developers must run `pnpm typecheck` after editing `scripts/` files (already part of the standard gate).

---

## Verification

- `pnpm --filter scripts typecheck` passes on all current `scripts/` files.
- `pnpm typecheck` (root) includes the new step and passes.
- All existing tests pass.
- The c32878f bug would now be caught at compile time. Empirically confirmed 2026-09-23: a repro of the c32878f shape (`const [ghMeta, orgResult] = …` destructure followed by a `ghMeta = ghMeta.valueOf()` reassignment) under `tsc --noEmit --checkJs --allowJs` emits `error TS2588: Cannot assign to 'ghMeta' because it is a constant.` — the exact class `node --check` is silent on.

---

## References

- Commit c32878f: "Fix scripts/ingest.js:293 'Assignment to constant variable' + regression test"
- Commit 71292a0: "fix: pass correct githubToken to ingestRepo (was shadowed by REGISTRY_FETCHERS_BY_ECOSYSTEM)"
- Commit 1ad3086: "chore: ingestion pipeline & CI hardening (Stages 1-3)" — removed dead code
- AGENTS.md §6 step 6 (belt-and-braces typecheck:tests pattern)
