---
name: deptend-live-verification
description: Use when verifying a DepTend change against real infrastructure — dev Neon live test blocks, drizzle-kit check, EXPLAIN, real OSV/GitHub contracts — because mocks pass while production breaks
---

# DepTend Live Verification

AGENTS.md §6's gate (typecheck → test → build → lint → format:check) has repeatedly passed while real bugs shipped. Every incident in this repo's history that survived it was a mock that didn't match the real contract: a mocked `db.transaction()` the real driver can't run; a mocked OSV batch response that returned a full record when the endpoint returns only `{id, modified}`; a fake SQL driver asserting statement text it never executed. This skill is the second half of the gate: exercise the change against real infrastructure at least once, or say explicitly that you couldn't.

## When to Use

- Any change to `packages/core/src/db/**` (query building, ORDER BY, COALESCE, indexes)
- Any change to `packages/core/src/ingestor/**` or `scorer/**` that touches an external contract (OSV, GitHub, a registry)
- Before flipping an ADR from Proposed to Accepted (AGENTS.md §10: live verification is the condition, not passing checks)
- Don't use for pure docs/UI-copy changes — the standard gate is enough.

## Safety first: which branch are you about to hit?

`.env.local` in this working tree points the two URLs at **different branches**:

| Var | Branch | Use |
|-----|--------|-----|
| `DATABASE_URL` (pooled) | dev | safe for probes and live test blocks |
| `DATABASE_URL_UNPOOLED` | **production** | DDL only, and only deliberately |

Never run a write probe, bulk writer, or migration against `DATABASE_URL_UNPOOLED` without deciding to. Read only key *names* when inspecting `.env.local`, never values.

## Procedure

1. **Standard gate first.** `pnpm run typecheck && pnpm test && pnpm run build && pnpm run lint && pnpm run format:check`. Fix anything red before going live — live time is expensive.

2. **Pick the live block that covers your change.** Three exist, all opt-in via `describe.skipIf(process.env.DATABASE_URL === "")`:

   | File | Covers |
   |------|--------|
   | `packages/core/src/db/directory-queries.test.ts` | directory severity tallies vs per-repo board totals (ADR 0053; the LEFT JOIN + COALESCE shape) |
   | `packages/core/src/db/board-queries.test.ts` | board `ORDER BY` executed against real Postgres |
   | `packages/core/src/scorer/writer.test.ts` | the bulk `UPDATE … FROM (VALUES …)` and bulk `INSERT … RETURNING id` (ADR 0043) |

   CI runs without `DATABASE_URL`, so all three are skipped there and prove nothing in CI.

3. **Run it against dev.** From the repo root:
   `node --env-file=.env.local ./node_modules/.bin/vitest run packages/core/src/db/directory-queries.test.ts`
   (any of the three paths; `--env-file` is what makes the `skipIf` gate open — vitest inherits `process.env`.)

4. **If it's a schema or migration change**, also run `./node_modules/.bin/drizzle-kit check --config=drizzle.config.ts` — it compares `schema.ts` against the committed journal and opens no connection, so it runs anywhere.

5. **If the claim is a query plan or a data-quality number**, get it from the database instead of inferring it: the Neon SQL editor for the relevant branch (verify the branch breadcrumb before running), or `psql "$DATABASE_URL_UNPOOLED"` when you need `EXPLAIN ANALYZE` (that URL is production-capable — treat as a decision point).

6. **Record the evidence.** An ADR's flip to Accepted needs a quotable artifact (the command, its real output, or a linked path under `reports/`). "Tests pass" is not evidence of live behavior.

## Pitfalls

- A green `pnpm test` says nothing about whether Postgres accepts your SQL. The fake driver asserts statement text; only step 3 executes it.
- `pnpm test` at the repo root runs `pnpm -r test`, which is what CI runs. A bare `vitest run` may load the wrong config — `app` needs `app/vitest.config.ts` for the `@/` alias, `scripts` needs `scripts/vitest.config.mjs`.
- The live blocks mutate the dev database (the writer block re-runs mission generation for its `psf/requests` fixture). That is intentional and dev-only — never point them at production.
- `drizzle-kit check` is safe everywhere; `drizzle-kit generate` writes a file and `drizzle-kit migrate` writes to the database. Both are decision points.
- If you cannot reach the real thing from this environment, say so in those words. AGENTS.md §6 is explicit that mock coverage is not a substitute, and silently treating it as one is how the last three incidents shipped.

## Verification

The skill worked if: the standard gate is green AND at least one live block executed (not skipped) against dev AND the command with its output is recorded in your report.