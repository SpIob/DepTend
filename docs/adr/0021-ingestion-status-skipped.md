# ADR 0021 — Ingestion Status: Distinguish "Skipped" from "Complete"

**Status:** Proposed
**Date:** 2026-07-21

---

## Context

After raising the repo cap to 10 (ADR 0020), Mico submitted the first 3 repos past the old limit. All three ingested with `ingestionStatus: 'complete'` and no `ingestionError`, yet produced zero missions and showed `dependencies_found`/`advisories_fetched`/`missions_created`/`missions_updated` as apparently empty in `ingestion_runs`.

Traced to the actual GitHub Actions log rather than guessed at: `NpmIngestor` correctly found no `package.json` at the repo root (`sherlock`'s default branch, confirmed via `fetchGitHubRepoMeta`, has none there) and logged `Found 0 dependencies` — a warning, not an exception. The "empty" `ingestion_runs` columns weren't actually empty; they were correctly-written zeros (`IngestionWriter.closeRun()` sets `status` and the count columns together in one UPDATE — there's no code path where one happens without the other). Confirmed via the same trace that all 3 repos hit this identically.

This isn't a data-loss bug. It's a real gap, though: a repo that isn't an npm project (or has its `package.json` somewhere other than the root — out of scope for this fix, Phase 1 was always root-only) silently counts as `'complete'`, occupies a cap slot, and gives no visible explanation anywhere. That's in tension with the project's own explainability standard (§6.3 — data limitations "must be communicated visibly, not hidden").

## Decision

**New `ingestion_status` enum value: `'skipped'`.** Distinct from both `'complete'` (a repo that was actually analyzed, even if it legitimately has zero dependencies) and `'failed'` (a genuine error worth retrying). The distinction matters operationally: `resolvePending()` re-picks `'pending'`/`'failed'` repos on every cron run — marking these `'failed'` would retry a repo that can never succeed, forever, burning API calls on nothing. Mico's choice over the no-migration alternative (reusing `ingestionError` while keeping `status: 'complete'`), trading a schema migration for a cleaner long-term model.

**Signal:** `IngestorResult` gained `package_json_resolved: boolean` — true once a manifest was actually found and parsed as a JSON object, even if it declares zero dependencies (that case stays `'complete'`); false when there was nothing to parse at all (missing, invalid JSON, or not an object). `IngestionWriter.write()` derives the final status from this flag and, when skipping, copies the specific warning into `repos.ingestionError` so the reason is visible, not just the fact that something was skipped.

**Dashboard:** a minimal note next to the existing repo count — `"N skipped"` — collapsed by `<details>`, expanding to the specific repo names and reasons. Mico's choice over building a full repo-status list, which doesn't exist anywhere in the UI yet and would have been a materially bigger feature.

## What changed

- `packages/core/src/db/schema.ts` — `'skipped'` added to `ingestion_status`.
- `packages/core/src/db/migrations/0001_overjoyed_wild_pack.sql` (generated via `drizzle-kit generate`, not hand-written) — the enum addition, **plus 3 unrelated `ALTER COLUMN ... SET DEFAULT` statements on `mission_scores`'s JSONB columns that Drizzle Kit surfaced as pre-existing drift** between `schema.ts`'s declared defaults and the last recorded migration snapshot — nobody had run `generate` since those defaults were last edited in `schema.ts`. Not introduced by this change; flagging because it's now bundled into the migration you'll actually run. Low-risk: the app always writes these three JSONB columns explicitly (`MissionWriter` never leaves them to fall back on a column default), so this only changes behavior for a write path that doesn't currently exist.
- `packages/core/src/ingestor/interface.ts`, `npm-parse.ts` — `package_json_resolved` added and set correctly across all four parse outcomes (not found / invalid JSON / not an object / successfully parsed, including the legitimately-empty case).
- `packages/core/src/ingestor/writer.ts` — `closeRun()`'s status type widened to include `'skipped'`; `write()` derives final status from `package_json_resolved` and sets `repos.ingestionError` accordingly; `WriteIngestionOutput` gained a `status` field.
- `scripts/ingest.js` — the "Done" log line now includes `status`, for faster diagnosis of exactly this kind of thing next time.
- `packages/core/src/db/queries.ts` — new `getSkippedRepos()`. No change needed to `getIndexedRepoCount()`/`getTotalRepoCount()` — they already filter/don't-filter by status in exactly the right way for this to compose correctly for free (indexed count excludes `'skipped'` automatically; total count, which the cap actually checks, still includes it — so a bad submission still costs a cap slot).
- `app/src/lib/queries/missions.ts`, `app/src/app/page.tsx` — wrapper + the minimal dashboard note.

## A verification-sequence gap found along the way

Adding a required field to `IngestorResult` should have caused a compile error everywhere a test file builds one without it. It didn't — not in `pnpm typecheck` (excludes test files by tsconfig scope, per ADR 0012's own design) and not in `pnpm lint` (type-aware ESLint rules don't surface plain "missing required property" errors — that's a `tsc` diagnostic, not a rule violation). Running `tsc --noEmit --project packages/core/tsconfig.eslint.json` directly — the config that supposedly exists to cover this, per ADR 0012 — is what actually caught it, and along with it, **two pre-existing, unrelated `exactOptionalPropertyTypes` violations** in `osv.test.ts` and `scorer/writer.test.ts` that had apparently never been caught by anything before. Both fixed here (behavior-neutral — omitting an optional key instead of explicitly setting it to `undefined`).

In short: test file type correctness has never actually been enforced by any of this project's five standard checks, despite a config existing specifically for that purpose. Worth closing — not done here, since it's a CI/tooling change outside this fix's own scope, but a concrete recommendation: add `tsc --noEmit --project packages/core/tsconfig.eslint.json` as its own script (or fold it into `pnpm lint`, since that's where the mental model already expects it to live) and wire it into `ci.yml`.

## Consequences

- Verified from a clean state: `typecheck` → `test` (283/283 — 270 in `packages/core`, up from 265; 5 new in `writer.test.ts` covering both the `'complete'`-with-empty-deps case and the new `'skipped'` path; 13 in `cli`, unchanged) → `build` → `lint --max-warnings 0` → `format:check` — all exit 0. The test-inclusive `tsc --noEmit` pass above also confirmed clean.
- **Applying the migration itself surfaced two more environment gaps**, both fixed here since they blocked this ADR's own rollout: (1) `drizzle.config.ts` had no mechanism to load `.env.local` for CLI tools — Next.js auto-loads it for `next dev`/`next build`, but a bare `pnpm exec drizzle-kit` never got it. Fixed by loading `.env.local` via `dotenv` at the top of the config, before `dbCredentials.url` is read. (2) With only `@neondatabase/serverless` installed, `drizzle-kit migrate` selects that package's WebSocket-based driver for its own CLI operations and hangs indefinitely against a real Neon connection (a documented, widely-reported interaction between `drizzle-kit` and `@neondatabase/serverless` in local/CLI contexts — the app's own runtime code is unaffected, since Vercel's serverless environment is exactly what that driver is for). Fixed by adding `postgres` as a devDependency — `drizzle-kit` prefers it automatically once installed, no config change needed, confirmed by the driver-selection line changing from `'@neondatabase/serverless'` to `'postgres'`.
- Not yet verified live: the migration hasn't been applied to Neon yet, and no repo has actually been re-submitted to confirm `'skipped'` shows up correctly end to end in production. `sherlock` and the other two affected repos are still sitting at `ingestionStatus: 'complete'` with zero missions until either the migration runs and they're manually corrected, or they're removed and resubmitted.
- Genuinely out of scope, not forgotten: repos whose `package.json` lives outside the repo root are still indistinguishable from repos with no `package.json` at all — both hit the same `'skipped'` path. Phase 1 was always root-only by design; broadening that is a real feature, not a bug fix, and hasn't been raised as a decision point here.
