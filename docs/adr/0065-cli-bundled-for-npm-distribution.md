# ADR 0065: Bundle the CLI into a Self-Contained Artifact for npm Distribution

**Status:** Accepted (implementation complete and verified locally 2026-11-15; npm registry publication pending maintainer 2FA)
**Date:** 2026-11-15

---

## Context

Preparing `@deptend/cli` for its first npm publish surfaced a packaging defect that would have shipped a broken package to every user. It is worth recording because the failure mode was silent — `pnpm publish` succeeds while producing an uninstallable tarball.

**The defect, reproduced end to end (2026-11-15):**

1. `cli/package.json` declared `"@deptend/core": "workspace:*"` as a runtime dependency.
2. `pnpm pack` rewrites that to a concrete version — `"@deptend/core": "0.0.1"` — in the published manifest.
3. `@deptend/core` is `private: true` and has never been published (`npm view @deptend/core` → E404).
4. Installing the real tarball in a clean directory:

   ```
   npm error 404 Not Found - GET https://registry.npmjs.org/@deptend%2fcore
   npm error 404  The requested resource '@deptend/core@0.0.1' could not be found
   ```

Every `npx @deptend/cli` would have failed at install. The CLI imports `@deptend/core` at runtime across 13 modules (ingestors, scorer, pipeline steps), so this is not a type-only import that compilation elides.

**Alternatives evaluated, each with its measured failure:**

| Option                                                                        | Outcome                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundledDependencies: ["@deptend/core"]` under pnpm                           | Rejected by pnpm: `ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED — bundledDependencies does not work with node-linker=isolated`. Adopting `node-linker=hoisted` repo-wide would restructure every workspace's `node_modules`. Not acceptable.                     |
| `bundledDependencies` forced via `npm pack` in a staging dir                  | Tarball **did** embed `core` (353 entries), and install succeeded — but npm installs no transitive dependencies of a bundled package, so the CLI still died: `Cannot find package 'drizzle-orm' imported from …/core/dist/db/repos.js`.                           |
| Publish `@deptend/core` publicly as well                                      | Would work, but publishes a second package under the maintainer's scope, permanently expands a public API surface, and installs `drizzle-orm` + `@neondatabase/serverless` for every CLI user. Unpublishing after npm's 72-hour window is effectively impossible. |
| Rewrite `@deptend/core/*` specifiers to relative paths and vendor `core/dist` | No new tooling, but the published package then needs 6 runtime dependencies declared by hand, and the rewrite step is bespoke build machinery.                                                                                                                    |

## Decision 1: Bundle the CLI with esbuild; ship zero runtime dependencies

`cli`'s build becomes a single esbuild invocation:

```
rm -rf dist && esbuild src/index.ts --bundle --platform=node --format=esm \
  --target=node20 --outfile=dist/index.js \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
```

`@deptend/core` moves from `dependencies` to `devDependencies` — accurate for a bundled artifact, where it is a build-time input rather than something the consumer resolves. The published manifest has **no `dependencies` key at all**.

Three details are load-bearing and were each found by running the artifact, not by reasoning about it:

1. **`rm -rf dist` first.** The previous `tsc` build emitted 60 files into `dist/`; `files: ["dist"]` would have published the bundle _plus_ 59 stale modules and a sourcemap describing code no longer in the package.
2. **The `createRequire` banner.** `@yarnpkg/lockfile` is CommonJS and calls `require("path")` dynamically. esbuild's ESM output cannot express that; without the banner the CLI dies immediately with `Error: Dynamic require of "path" is not supported`. The banner defines a real `require` via `createRequire(import.meta.url)`.
3. **esbuild resolves `@deptend/core` through core's `exports` map**, i.e. against core's built `dist/`, so the CLI still runs byte-for-byte the same engine code the dashboard runs — the invariant the README states. `prebuild` retains `pnpm --filter @deptend/core build` to guarantee core is built first.

## Decision 2: `dist/index.js` is a build artifact, not a typed library

The CLI exposes no programmatic API — `bin` is its only entry point and nothing in the repo imports `@deptend/cli`. Dropping `tsc`'s declaration emit therefore costs nothing. Type safety is unchanged: the separate `typecheck` script (`tsc --noEmit`) remains in the build gate, and the CLI's own test suites still run against `src/`.

## Consequences

**Verified (2026-11-15), all from the packed tarball, not from `src/`:**

- Tarball is 3 files / 131.6 kB packed, 639.2 kB unpacked — `package.json`, `dist/index.js`, `LICENSE`.
- `npm install` into a clean directory: `added 1 package … in 761ms`, **zero** registry dependency resolution.
- `--help` renders correctly; the shebang survives and precedes the banner.
- A full analysis run against a real npm fixture with `--github-url https://github.com/SpIob/devlog-cli` produced 12 ranked missions with scores, effort labels, and confidence flags from live OSV/npm/GitHub data, exit 0.
- Only bare imports remaining in the bundle are Node builtins (`node:crypto`, `node:fs/promises`, `node:path`, `node:url`).

**Costs accepted:**

- 621.6 KB bundle, because `drizzle-orm` is inlined — see the first follow-up below. This is dead weight for a local-first CLI.
- `esbuild` becomes a `devDependency` of `cli`. It is free, already present transitively (0.28.2 via `drizzle-kit`/`vitest`), and requires no change to `pnpm-workspace.yaml` or the pnpm overrides block.
- A bundler now sits between source and the published artifact, so the existing `tsc --noEmit` gate is the only compile-time contract. Deliberate: it keeps one implementation, and the bundle is verified by running it.

**Follow-ups this ADR does not resolve:**

1. **A local-first, no-DB CLI currently has the Postgres layer in its import graph.** `core/src/pipeline/parse-github-url.ts` imports `core/src/db/repos.ts`, which imports `drizzle-orm`. That drags the ORM into the CLI's runtime graph (and into this bundle) purely to reach a URL-string parser. Extracting the pure parser out of the repo layer would let the bundle drop the ORM entirely. Deferred as a separate change: it touches `core`, which the dashboard also consumes, so it needs its own verification pass.
2. **The rate-limit warning names the wrong variable for CLI users.** `cli/src/index.ts:131` reads `GITHUB_TOKEN`, but the shared `GITHUB_TOKEN_WARNING` constant it prints at line 133 tells users to set `GH_INGEST_TOKEN` (the ingest script's variable). A CLI user following the warning sets a variable the CLI never reads. First-run friction aimed squarely at the CLI's intended audience.
3. **Publication itself is unresolved:** npm rejected the publish with `E403 — Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages`. The verified tarball at `cli/deptend-cli-0.1.0.tgz` is ready; it needs one interactive `--otp=` publish by the maintainer, or an automation token.
4. **The README documented `npx deptend`, which cannot work** — the package is `@deptend/cli`, so `npx deptend` resolves a package that does not exist. Corrected to `npx @deptend/cli` in the same pass.

## Rollback

Revert `cli/package.json` (restore the `tsc` build, `dependencies`, remove `esbuild`), drop this ADR, and re-run `pnpm install`. Nothing outside `cli/` changed: `packages/core`, `app/`, the database schema, the scoring engine, and every other workspace are untouched. The published npm package cannot be un-published after 72 hours, so this decision is one-way for version 0.1.0 — hence the deliberate choice to publish 0.1.0 as a pre-1.0 version.
