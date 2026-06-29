# ADR 0001 — Monorepo Structure and Technology Stack

**Status:** Accepted  
**Date:** 2026-06-29  
**Phase:** 0 — Foundation

---

## Context

deptend.dev is a zero-budget, solo-developer project that shares logic across three consumers: a Next.js web application, a Node.js CLI, and scheduled ingestion scripts. Keeping these in separate repos would require publishing packages or using git submodules — both add operational overhead that is unacceptable for a solo build.

## Decision

Use a **pnpm monorepo** with the following package layout:

| Package | Path | Language | Notes |
|---|---|---|---|
| Next.js app | `/app` | TypeScript | Frontend + API routes |
| CLI companion | `/cli` | TypeScript | npx-runnable; Phase 4 |
| Shared core | `/packages/core` | TypeScript | Dependency parsing, scoring |
| Ingestion scripts | `/scripts` | JavaScript | Runs in GitHub Actions |
| Documentation | `/docs` | Markdown | ADRs, data model, setup guide |

**Package manager:** pnpm (not npm, not yarn).  
**Reason:** pnpm's symlinked `node_modules` prevents phantom dependency bugs common in monorepos, it is free, and Vercel supports it natively.

**TypeScript requirement:** All `/app` and `/packages/core` code must be TypeScript. Plain JavaScript is acceptable in `/scripts` only, because ingestion jobs run in CI and do not share types with browser or CLI consumers.

## Alternatives considered

| Option | Rejected because |
|---|---|
| Separate repositories | Requires publishing `@deptend/core` to npm registry or using git submodules; adds release overhead unacceptable solo. |
| Turborepo | Adds an orchestration dependency with its own learning curve. pnpm's built-in `--filter` and `--recursive` are sufficient at this scale. |
| Yarn workspaces | No material advantage over pnpm for this project; pnpm is already decided. |
| npm workspaces | Slower than pnpm; phantom dependency risk in flat `node_modules`. |

## Consequences

- All packages share `tsconfig.base.json` at the repo root; per-package configs extend it.
- ESLint and Prettier are configured once at the root and apply to all packages.
- `pnpm install` at the root installs all workspace dependencies in one pass.
- CI (`ci.yml`) must run `pnpm --filter @deptend/core build` before any consumer typecheck, because the CLI and app import from `@deptend/core`'s compiled output.

## Free-tier compliance

pnpm: free, MIT licensed.  
GitHub Actions: free for public repos (unlimited minutes).  
Vercel Hobby: free, supports pnpm and Next.js natively.  
Neon: free tier used for PostgreSQL.
