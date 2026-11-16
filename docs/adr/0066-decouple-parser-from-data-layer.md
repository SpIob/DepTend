# ADR 0066: Decouple the GitHub URL Parser from the Data Layer

**Status:** Accepted (implemented and verified 2026-11-16)
**Date:** 2026-11-16

---

## Context

Two follow-ups from ADR 0065 blocked a clean first publish of `@deptend/cli`. Both were discovered _during_ the packaging work, not beforehand, and both traced to a shared root cause: **code that belongs in the pipeline layer lived in the data layer**.

### Follow-up 1: The pure parser pulled `drizzle-orm` into the CLI

`packages/core/src/pipeline/parse-github-url.ts` was a 9-line re-export shim:

```ts
export { parseGithubUrl } from "../db/repos.js";
```

`db/repos.ts` imports `drizzle-orm` for its actual database queries. Because ESM re-exports are **transitive module loads**, every consumer of the shim — including the CLI — pulled the entire ORM into its module graph. The CLI's `dist/index.js` ballooned to **636.5 KB** solely for a pure regex URL parser.

Measured impact:

| Build                              | Size     | Delta                 |
| ---------------------------------- | -------- | --------------------- |
| With `db/repos.ts` re-export       | 636.5 KB | —                     |
| Parser in `pipeline/` (no drizzle) | 530.3 KB | **−106.2 KB (16.7%)** |

### Follow-up 2: The token warning was dead code with a wrong message

`packages/core/src/pipeline/github-token-warning.ts` exported a constant `GITHUB_TOKEN_WARNING`:

```ts
export const GITHUB_TOKEN_WARNING =
  "GH_INGEST_TOKEN is not set. GitHub API calls will be unauthenticated " +
  "(60 req/hr limit). Set GH_INGEST_TOKEN to raise the limit to 5,000 req/hr.";
```

The module's header claimed it was "Used by both scripts/ingest.js and cli/src/index.ts." **That was false.** A repo-wide grep proved:

- `scripts/ingest.js` **does not import it** — it has its own `fatal()` message (the token is _required_ there).
- `cli/src/index.ts` was the **only** consumer.

The CLI reads `GITHUB_TOKEN`, but the shared constant told users to set `GH_INGEST_TOKEN` — a first-run user following the warning set a variable the CLI never read, saw the same warning again, and concluded the tool was broken.

The module was dead code with exactly one consumer, and its message was wrong for that consumer.

---

## Decision 1: Move `parseGithubUrl` to the pipeline layer; drop the shim

Create `packages/core/src/pipeline/parse-github-url.ts` as the **implementation** (pattern + function), not a re-export. Update `db/repos.ts` to remove the pattern and function, adding a pointer comment. Update consumers:

| Consumer                             | Before                                              | After                                                        |
| ------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------ |
| `cli/src/index.ts`                   | `@deptend/core/pipeline/parse-github-url.js` (shim) | same path, now the implementation                            |
| `scripts/ingest.js`                  | `@deptend/core/pipeline/parse-github-url.js` (shim) | same path, now the implementation                            |
| `scripts/integration.test.js`        | `@deptend/core/pipeline/parse-github-url.js` (shim) | same path, now the implementation                            |
| `app/src/app/api/repos/route.ts`     | `@deptend/core/db/repos.js`                         | split import: `parseGithubUrl` from pipeline, others from db |
| `packages/core/src/db/repos.test.ts` | imports from `./repos.js`                           | tests moved to `pipeline/parse-github-url.test.ts`           |

`db/repos.ts` no longer re-exports `parseGithubUrl`. It adds a pointer comment explaining the move and referencing ADR 0066 — the trap is documented so it doesn't reappear.

### Test migration

The `parseGithubUrl` describe block (63 lines, 36 test cases) moved from `db/repos.test.ts` to a new `pipeline/parse-github-url.test.ts`. The header explains the move and references ADR 0066. `db/repos.test.ts` header updated to list the three remaining DB-layer units.

---

## Decision 2: Delete the dead `github-token-warning.ts` module

`github-token-warning.ts` had exactly **one** consumer (the CLI) and its message was wrong for that consumer. Removed:

- `packages/core/src/pipeline/github-token-warning.ts` (file deleted)
- Export entry `"./pipeline/github-token-warning.js"` from `packages/core/package.json`

### CLI fix

`cli/src/index.ts` now:

1. Reads `process.env.GITHUB_TOKEN ?? process.env.GH_INGEST_TOKEN ?? null` — accepts both, with `GITHUB_TOKEN` as primary.
2. Inlines the warning, naming both variables:
   ```
   GITHUB_TOKEN is not set. GitHub API calls will be unauthenticated
   (60 req/hr limit). Set GITHUB_TOKEN (or GH_INGEST_TOKEN in CI) to raise the limit to 5,000 req/hr.
   ```
3. Removes import of the deleted shared module.
4. Updates the doc comment: "CI pipelines may also set GH_INGEST_TOKEN (used by the scheduled ingestion)."

This is honest about which variable is which, and a user who previously set `GH_INGEST_TOKEN` (following the old warning) now finds it actually works.

---

## Consequences

### Verified (2026-11-16), all from the packed tarball

- Bundle size: **530.3 KB** (down from 636.5 KB, −16.7%).
- Zero non-builtin imports in the bundle — no `drizzle-orm`, no `@neondatabase/serverless`.
- All gates pass: typecheck, 113 CLI tests + 871 core tests, lint, format, build.
- Tarball installs in 493 ms with zero registry resolution.
- Live run produces 12 ranked missions, exit 0.
- Token fallback: setting only `GH_INGEST_TOKEN` works (tested with a fake token → 401, proving it's used).

### Costs accepted

- `app/src/app/api/repos/route.ts` now has a split import — minor churn, but it's the only non-CLI consumer that used the old path, and the change is explicit.
- A dead module (`github-token-warning.ts`) was removed from a private package. No external consumer existed.

### Rollback

Revert the file moves, restore the shim, restore `github-token-warning.ts`, and re-add the export. The CLI's `dist/` is regenerated on next build. Nothing outside `packages/core/src/` and `cli/src/` changed.

---

## Follow-ups this ADR does not resolve

None — both follow-ups from ADR 0065 are resolved here.
