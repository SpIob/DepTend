# ADR 0020 — Raise the Repo Cap from 3 to 10

**Status:** Accepted
**Date:** 2026-07-20
**Phase:** 5 → 6 transition

---

## Context

The project plan's own risk register (§8) explicitly called for this: "MVP is capped at 3 repos... **Re-evaluate cap before Phase 5**." That re-evaluation didn't happen at Phase 5 kickoff — it surfaced only when closing out Phase 5's status doc (Outstanding #2). Addressed here rather than carried forward again into Phase 6.

The original cap of 3 was set in ADR 0002 against Neon's free-tier storage limit (0.5 GB), before any real ingestion data existed to check that assumption against. Two things have changed since:

1. **Real measurement, not estimation.** The Neon dashboard showed `0.03/0.5GB` with one repo indexed. After submitting and fully ingesting a second real repo, the dashboard reading was unchanged — meaning the marginal storage cost of one repo is below the dashboard's display rounding step (roughly 5–10 MB, inferred from 2-decimal-place GB display). The ~30 MB baseline is essentially fixed overhead (Postgres system catalogs, index structures across all 7 tables, the `pgcrypto` extension, `__drizzle_migrations`, Neon's 6-hour point-in-time-recovery window) — not something that scales with repo count. This matches a schema-level estimate done independently beforehand (tens of KB per repo: `dependencies`, `advisories`/`dependency_advisories` — the latter partially shared across repos via deduplicated advisories per ADR 0004 — and `missions`/`mission_scores`, all upsert-based, not append-only).
2. **ADR 0017 already validated ranking correctness past 3 repos.** ADR 0007 §7 explicitly flagged, at design time, that the ranking tie-break wasn't provably transitive and judged this acceptable "while the 3-repo MVP cap kept mission lists small" — flagged as worth revisiting "in case that assumption stops holding." It stopped holding once 3 real repos actually got indexed (not from a cap raise — from the cap being fully exercised), and ADR 0017 fixed it with tier-bucketing, which produces a real transitive equivalence class regardless of how many missions are being ranked. ADR 0017 itself already anticipated this exact decision: "If the repo cap is raised past 3 ... this fix is what keeps ranking correct at larger scale ... now validated at exactly the scale ADR 0007 was worried about, not just a future concern."

Given both the storage constraint and the one known correctness risk are already addressed, the only remaining consideration was Mico's actual preference for how far to raise it — not a hard technical ceiling.

## Decision

**Repo cap raised from 3 to 10.** Mico's choice among conservative (10) / moderate (15) / aggressive (25) — the smallest step offered, consistent with the project's founding zero-budget caution even though the infra headroom would comfortably support more.

**Changed:**

- `.env.example` — `NEXT_PUBLIC_MAX_REPOS="3"` → `"10"`.
- `app/src/app/api/repos/route.ts`, `app/src/app/page.tsx` — the `?? "3"` fallback default (used only if the env var is somehow unset) updated to `?? "10"` to match, so the two can't silently drift apart.
- `README.md` — "capped at 3 indexed repos" → "capped at 10 indexed repos."
- `packages/core/src/ingestor/registry.ts` — the npm-registry concurrency-budget comment's stale "≤ 3 repos" reference corrected, and clarified _why_ the 10-concurrent-request budget claim was never actually repo-count-dependent in the first place: `scripts/ingest.js` processes repos strictly sequentially (`for (const repo of targetRepos) { await ingestRepo(...) }`), so registry fetches never overlap across repos regardless of how many are indexed. Confirmed by reading the actual loop before editing the comment, not assumed.

**Explicitly not changed:** the ranking algorithm (already correct at scale per ADR 0017), the DB schema (no migration — this is a config value, not a structural change), and the OSV/npm-registry fetch logic (concurrency budget confirmed unaffected, see above).

**Operational step, outside this codebase change:** `NEXT_PUBLIC_MAX_REPOS` must also be updated wherever it's actually set for the deployed app — Vercel's environment variables and any local `.env.local` — since `.env.example` only documents the expected shape, it isn't itself read at runtime.

## Consequences

- Verified from a clean state: `typecheck`, `test` (278/278, unchanged — this is a config/comment/doc change, no new logic), `build`, `lint --max-warnings 0`, `format:check` — all exit 0.
- Not yet verified live: no repo has been submitted against the new cap yet (only against the still-in-effect 3, during the storage measurement above). Worth a quick submission past the old limit once the env var is actually updated in Vercel, to confirm the cap check itself (`submitRepo()`'s count-then-insert in `repos.ts`) behaves correctly at the new number — it's parameterized, not hardcoded, so this should be a non-event, but this project's own history (ADR 0016) has shown "should be a non-event" and "confirmed a non-event" aren't the same thing.
- `ingest.yml`'s daily cron processes `resolvePending()` — all repos with `status: 'pending'` or `'failed'` — with no batch-size limit of its own. At 10 repos instead of 3, a single cron run takes proportionally longer (sequential, not parallel, per the registry.ts finding above) but this was already unbounded by cap size; going from 3 to 10 doesn't introduce a new failure mode, just a longer one run.
