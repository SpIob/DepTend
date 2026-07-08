# ADR 0008 — Mission DB Writer: Read Query, Upsert Strategy, Type Bridging

**Status:** Proposed
**Date:** 2026-07-06
**Phase:** 2 — Scoring Engine

---

## Context

ADR 0007 covered mapping DB rows onto scorer inputs; this covers actually reading those rows via Drizzle, writing `missions` / `mission_scores`, and hooking the result into `scripts/ingest.js`. Three real issues surfaced while building this that weren't visible from the schema alone.

## 1. `db/types.ts` and `schema.ts` are two independent, non-interchangeable type systems

This is a bigger version of the already-flagged `types.ts` housekeeping item. It's not just a stale header comment — the interfaces themselves have diverged:

- `schema.ts` exports `Repo`/`Dependency`/`Advisory`/etc. via `$inferSelect`, camelCase (`cvssScore`, `versionSpec`), with `numeric` columns inferred as `string` (no `{ mode: "number" }` set) and `jsonb` columns inferred as `unknown`. Its own comment reads: _"Use these throughout /app and /packages/core instead of hand-written interfaces."_
- `db/types.ts` hand-writes its own `Repo`/`Dependency`/`Advisory`, snake_case (`cvss_score`, `version_spec`), with `cvss_score: number` and narrowly-typed JSONB shapes (`affected_versions: OsvVersionRange[]`).

`scorer/interface.ts` (Phase 0) already committed to the `db/types.ts` shapes for `ImpactInputs`/`EffortInputs`/`EcosystemValueInputs`, and `impact.ts`/`effort.ts`/`ecosystem-value.ts`/`mission-scorer.ts` (Phase 2) are all built and tested against them. Rewriting that layer to consume `schema.ts`'s shapes instead would touch every scorer file for no scoring-logic benefit.

**Decision:** the new `MissionWriter` reads via Drizzle (`schema.ts` shapes) and converts to `db/types.ts` shapes at the boundary, via small mapping functions (`toCoreRepo`, `toCoreDependency`, `toCoreAdvisory` in `scorer/writer.ts`). This confines the divergence to one file rather than spreading `schema.ts` imports into the pure-function scoring layer. The conversion includes the numeric-string-to-number cast flagged in ADR 0007, and narrows the two `unknown`-typed JSONB fields (`affected_versions`, `raw_data`) to their known shapes — safe here because this data was written by our own `OsvFetcher` in the first place.

**This isn't a fix, it's a bridge.** The actual fix — making `db/types.ts` derive from `schema.ts` via `$inferSelect` instead of hand-duplicating it — is a real refactor touching `scorer/interface.ts`'s public contracts and every file built against them. Flagging it explicitly rather than doing it as a side effect of this ADR: worth scheduling deliberately, not absorbed here.

## 2. `missions` has no unique constraint — no `ON CONFLICT` target exists

Unlike `dependencies` (`unique` on `repo_id, package_name, dep_type`) or `mission_scores` (`missionId` is `.unique()`), `missions` only has non-unique indexes. There's no column set Postgres' `ON CONFLICT` could target for `(dependency_id, advisory_id)`.

**Decision:** `MissionWriter` does a manual check-then-write instead of `onConflictDoUpdate` — `SELECT id FROM missions WHERE dependency_id = ? AND advisory_id = ?`, then `UPDATE` if found, `INSERT` if not. This has a small race window under concurrent writers, which isn't a concern here: ingestion for a given repo runs from a single cron/manual invocation, not multiple concurrent processes.

Adding a real unique constraint would need a Drizzle Kit migration — flagging that as the schema-migration decision point your rules call for, rather than adding it unilaterally. The manual-upsert approach works fine without one; a migration would only be worth it if `missions` grows large enough that the extra `SELECT` per mission becomes a real cost, which won't happen at a 3-repo MVP cap.

## 3. Re-running ingestion must not clobber user-driven mission state

`missions.status`, `claimed_by`, `claimed_at`, `resolved_at`, `dismissed_at`, `dismiss_reason` don't exist yet in any UI (Phase 3), but the columns do, and this writer runs nightly. If a user later claims or resolves a mission and the next night's cron re-generates it, overwriting `status` back to `"open"` would silently erase that action — the opposite of what a maintenance tracker should do.

**Decision:** on update, `MissionWriter` only touches `title`, `description`, `action_hint`, and `updated_at`. It never writes `status` or any claim/resolution field. `mission_type` is likewise only set on insert (it's `"vulnerability_fix"` for every mission created in Phase 2 per ADR 0007 — nothing to update).

**Explicitly not handled here:** what happens when a dependency stops being affected (the `dependency_advisories` row disappears or flips `is_affected` to `false` on a later run). The existing mission is left untouched — not auto-resolved, not auto-dismissed. Deciding that (should it require confirming the fix actually landed? should it just go stale until someone looks?) is a mission-lifecycle question that belongs with the Phase 3 dashboard work, not this pass — silently guessing at it here risks a wrong-by-default behavior that's hard to notice until a user relies on it.

## 4. Mission copy is templated, not generated at runtime

`missions.title` / `description` are `NOT NULL`, so something has to produce them. `mission-copy.ts` builds them from deterministic string templates over the advisory/dependency data — no LLM call, which would add a runtime dependency on a paid API and non-deterministic output, neither of which fits zero-budget or transparency-first. Regenerated on every write (not preserved from a prior run), since the underlying advisory data can change between runs and the copy should reflect the current data.

## 5. `scripts/ingest.js` integration and failure handling

`MissionWriter.generateMissionsForRepo()` is called immediately after `IngestionWriter.write()` succeeds, using the same `repoId`. `ingestion_runs.missions_created` / `missions_updated` (columns already existed, unused since Phase 0) are updated directly by `ingest.js` on the same run row — kept out of `MissionWriter` itself so it stays focused on `missions`/`mission_scores` only.

**Decision on failure:** if mission generation throws, the repo's dependency/advisory data (already written and valid) is _not_ rolled back or marked `failed` — that data is real and useful on its own. But the repo now has stale or missing missions, which is a real problem for anyone using the dashboard, so `ingestRepo()` still returns `false` for that repo (counted in `failCount`, non-zero exit, surfaced by the `::error::` annotation from the `ingest.yml` fix). This is a judgment call, not a schema/architecture decision — flagging it as one worth revisiting if it turns out to be too aggressive in practice.

## Free-tier compliance

No new services, no new dependencies, no schema migration.
