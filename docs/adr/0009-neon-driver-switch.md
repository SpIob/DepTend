# ADR 0009 — Switch `scripts/ingest.js`'s DB Driver from `neon-http` to `neon-serverless` (WebSocket)

**Status:** Accepted
**Date:** 2026-07-07
**Phase:** 2 — Scoring Engine (fix applies retroactively to Phase 1 code too)

---

## Context

Running `scripts/ingest.js` against a real Neon database for the first time (manual smoke test, `deptend-test-fixture` repo) failed at the first DB write:

```
Error: No transactions support in neon-http driver
    at NeonHttpSession.transaction (.../drizzle-orm/neon-http/session.js:152:11)
    at IngestionWriter.write (.../packages/core/dist/ingestor/writer.js:53:42)
```

This is not a bug introduced in Phase 2. `drizzle-orm/neon-http` — the driver `scripts/ingest.js` has used since Phase 0 — genuinely does not support Drizzle's callback-style `db.transaction(async (tx) => {...})`, and never has. Confirmed against Drizzle's own docs and multiple independent reports of the identical error going back to 2023: the HTTP driver speaks one-shot HTTP requests to Neon's proxy, with no persistent session to hold `BEGIN`/`COMMIT` across sequential awaited statements. Drizzle's own connect-to-Neon guide is explicit: _"If you need session or interactive transaction support ... you can use the WebSocket-based neon-serverless driver."_

**Both `IngestionWriter.write()` (Phase 0/1) and `MissionWriter.generateMissionsForRepo()` (Phase 2) use `db.transaction()` and are equally broken by this** — `MissionWriter` didn't introduce the problem, it inherited it by correctly following `IngestionWriter`'s established convention.

**Worth checking directly: has the `ingest.yml` daily cron ever actually succeeded since Phase 1?** Phase1_Status.md's "CI is green on main" refers to lint/typecheck/unit tests passing — none of which exercise a real Neon connection (writer.test.ts mocks `db.transaction` entirely, so this never had a chance to surface there). If the cron has been hitting this same error every night, it would show as a failed run in the Actions tab, and (since the `ingest.yml` fix a few days ago) post an `::error::` annotation — but a failed _scheduled_ workflow doesn't stop the repo from otherwise looking healthy, and GitHub's failure-notification emails are easy to miss. Recommend checking the Actions run history directly rather than assuming.

## Decision

Switch `scripts/ingest.js`'s DB client construction from the HTTP driver to the WebSocket-based `neon-serverless` driver, which provides real sessions and `node-postgres`-compatible transaction support:

```js
// Before
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
const sql = neon(databaseUrl);
const db = drizzle(sql, { schema });

// After
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
const pool = new Pool({ connectionString: databaseUrl });
const db = drizzle(pool, { schema });
```

**Zero new dependencies.** This is the same already-installed `@neondatabase/serverless` package (a different export, `Pool` instead of `neon`) and the same already-installed `drizzle-orm` (a different sub-path import). Neon/Drizzle's docs show a `ws` package being added for WebSocket support in Node — **not needed here**: that requirement is explicitly for **Node v21 and earlier**; this project runs Node 24 (CI) / 26 (local), both well past Node 22, where a native global `WebSocket` client is built in. Confirmed directly against the installed `drizzle-orm/neon-serverless/session.d.ts` (not just docs) that the exported `NeonTransaction<TFullSchema, TSchema>` type takes the same two type arguments the code already assumes.

**`Pool` needs explicit cleanup; `neon()` didn't.** The HTTP client was stateless — no connection to close. A `Pool` holds an open WebSocket that must be closed or the Node process hangs after work is done. `main()`'s per-repo loop is wrapped in `try { ... } finally { await pool.end(); }`, guaranteeing cleanup whether the loop finishes normally or throws.

**Type changes are mechanical, not structural.** `IngestionWriter` and `MissionWriter` both define a private `AnyNeonDb`/`AnyNeonTx` pair for exactly this reason — the only edit needed in either file is the import source and the outer database type name:

```ts
// Before
import type { NeonHttpDatabase, NeonTransaction } from "drizzle-orm/neon-http";
type AnyNeonDb = NeonHttpDatabase<any>;
type AnyNeonTx = NeonTransaction<any, any>;

// After
import type { NeonDatabase, NeonTransaction } from "drizzle-orm/neon-serverless";
type AnyNeonDb = NeonDatabase<any>;
type AnyNeonTx = NeonTransaction<any, any>;
```

Nothing else in either writer changes — the query builder API (`.select()`, `.insert()`, `.transaction()`, etc.) is identical across Drizzle's Postgres drivers by design.

## Alternatives considered

| Option                                                                                      | Why not                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Drop `db.transaction()` entirely; do sequential non-transactional writes                    | Would work, but throws away the atomicity both writers were explicitly designed around ("either all writes land or none do") for no reason — the real fix is free and just as simple.                                                                        |
| Use Neon's HTTP-level batch `sql.transaction([...])`                                        | Only accepts a static, upfront array of queries — incompatible with `IngestionWriter`'s and `MissionWriter`'s control flow, both of which run conditional logic (e.g. `MissionWriter`'s check-then-insert-or-update) between queries inside the transaction. |
| Keep `neon-http` for `scripts/ingest.js`, add a second driver just for transactional writes | More moving parts than switching the one script that needs transactions to the driver built for that, with no upside.                                                                                                                                        |

`/app` (Next.js on Vercel, Phase 3+) is unaffected by this decision — nothing there has been built yet, and it may reasonably keep `neon-http` for simple reads once it exists, switching to `neon-serverless` only if/when it needs its own transactional writes.

## Consequences

- `packages/core/src/ingestor/writer.ts` (Phase 0/1) and `packages/core/src/scorer/writer.ts` (Phase 2) both get the same two-line type-import edit.
- `scripts/ingest.js` gets the driver swap plus `pool.end()` cleanup.
- No schema change, no new service, no new dependency.
- Worth a real re-run against the same test fixture to confirm the fix actually works end-to-end — this ADR fixes what the error message and driver docs say is wrong, but hasn't itself been run against a live Neon database.

## Free-tier compliance

Same Neon free tier, same already-installed packages. No cost change.
