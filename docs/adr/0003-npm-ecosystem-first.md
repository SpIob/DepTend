# ADR 0003 — npm as the First Supported Ecosystem

**Status:** Accepted  
**Date:** 2026-06-29  
**Phase:** 0 — Foundation

---

## Context

The project must pick one package ecosystem to support first. Depth in one ecosystem is better than shallow coverage of many.

## Decision

Support **npm (JavaScript/Node.js)** in Phase 1. All other ecosystems are Phase 6+.

Three factors drove this choice:

1. **Largest dependency graph volume.** npm has more transitive dependencies per average project than any other ecosystem, making prioritization the most painful — and therefore most valuable — problem to solve there first.

2. **Best free data availability.** OSV, GHSA, and the npm registry API are all open and well-documented with no authentication required for public package data. This is ideal for a zero-budget project.

3. **Solo-developer fit.** JavaScript/Node.js allows the frontend (Next.js) and the ingestion logic (`@deptend/core`) to share language, tooling, and type definitions. This eliminates the context-switching overhead of managing two languages simultaneously.

**Recommended second ecosystem:** PyPI (Python), added in Phase 6+. The ingestor interface (`packages/core/src/ingestor/interface.ts`) is defined generically so that adding PyPI requires only a new `EcosystemIngestor` implementation, not a redesign of the core pipeline.

## Alternatives considered

| Ecosystem        | Notes                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------- |
| PyPI             | Strong second choice. Good OSV coverage. Deferred to Phase 6+.                          |
| Maven (Java)     | Adequate OSV coverage, but adds JVM complexity to a Node.js-only build.                 |
| crates.io (Rust) | Excellent data quality (RUSTSEC), but Rust ecosystem is smaller; fewer potential users. |
| RubyGems         | OSV coverage is more sparse.                                                            |

## Consequences

- Phase 1 ingestion parses `package.json` only. `package-lock.json` and `pnpm-lock.yaml` parsing is deferred (documented visibly in the UI as a confidence flag).
- The `ecosystem` column in all schema tables is typed as an enum starting with `npm`. New values are added via `ALTER TYPE ecosystem ADD VALUE` — existing values are never removed or reordered.
- The `EcosystemIngestor` interface in `packages/core/src/ingestor/interface.ts` must remain stable across phases. Any breaking change to the interface requires an ADR.
