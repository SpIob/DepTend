# ADR 0017 — Ranking Tie-Break Transitivity Fix

**Status:** Proposed
**Date:** 2026-07-16
**Phase:** 3 → 4 transition (found while verifying real production data, before Phase 4 work began)

---

## Context

ADR 0007 §7 specified and implemented `rankMissions()`'s tie-break rule: sort by `composite_score` descending, treat scores within `COMPOSITE_TIE_EPSILON` (0.5) of each other as tied, break ties by `effort_label` ascending, then `created_at` ascending. That same section flagged, at the time, that pairwise `|a - b| <= epsilon` "tied" comparisons aren't transitive (A≈B and B≈C doesn't guarantee A≈C), and judged it "isn't worth the extra complexity of clustering ties" while the 3-repo MVP cap kept mission lists small — explicitly noting this should be revisited "in case that assumption stops holding."

It stopped holding. Mico submitted and indexed 3 real repos and reported missions weren't consistently ordered critical-to-low across the combined dashboard, even though each repo's own missions looked right in isolation. Reproduced directly: a chain of four missions with composite scores 0.4 apart at each step (6.5/high, 6.1/medium, 5.7/low, 5.3/trivial — each adjacent pair within the 0.5 epsilon, but the two ends 1.2 apart) sorted to three different orders depending only on what order the same four missions were fed into `rankMissions()` in. `Array.prototype.sort()` assumes its comparator defines a consistent total order; a non-transitive comparator doesn't guarantee one, and the actual result becomes an artifact of the sort algorithm's internal comparison sequence rather than anything meaningful about the data. `getOpenMissionsWithScores()` (`db/queries.ts`) has no `ORDER BY` at the SQL level — rows come back from the join in whatever order Postgres returns them, so this was never something a stable input order could have papered over.

This is the first bug in the project found by neither the five standard checks nor by exercising a specific feature live — it took real data at real volume (3 repos' worth of missions, not one 2-dependency fixture) to create a chain long enough to expose the non-transitivity in practice.

## Decision

Replaced pairwise epsilon comparison inside the sort comparator with tier bucketing: `compositeTier(score) = Math.floor(score / COMPOSITE_TIE_EPSILON)`. Two missions are now "tied" iff they land in the same fixed-width tier (e.g., with epsilon 0.5: `[5.0, 5.5)` is tier 10, `[5.5, 6.0)` is tier 11). Sorting then proceeds by `(tier descending, effort_label ascending, created_at ascending)` — a strict lexicographic comparison over fixed, independently-computed keys, which is transitive by construction, unlike a relation defined by pairwise distance.

**Trade-off, stated plainly:** any fixed bucketing scheme will disagree with a "pairwise within epsilon" reading of "tied" somewhere near a tier boundary. Two scores 0.3 apart that straddle a boundary (e.g. 7.2 and 7.5, tiers 14 and 15) are no longer tied, even though they were under the old pairwise rule; two scores nearly 0.5 apart that fall inside the same tier (e.g. 7.05 and 7.49, both tier 14) are tied, same as before. This isn't a bug in the fix — it's the necessary cost of making "tied" a real equivalence class instead of a fuzzy, order-dependent relation. `ranking.test.ts` documents the new boundary behavior explicitly rather than leaving it implicit.

**Why bucketing over alternatives:**

- _Sort by raw `composite_score` alone, drop the tie-break entirely_ — rejected. The tie-break's purpose (prefer the easier win among near-equal-priority missions) is a real product decision from ADR 0006/0007, not incidental; removing it changes behavior far more than fixing the transitivity bug requires.
- _Cluster ties via a graph/union-find over the pairwise relation before sorting_ — the more general approach ADR 0007 gestured at ("clustering ties before sorting"). Correct, but meaningfully more code for a solo-maintained scoring module, and produces the same practical guarantee (a real equivalence class) as tier bucketing for this specific case. Not worth the complexity given fixed-width scores in a known range.
- _Round instead of floor_ — considered; rounding centers buckets on multiples of epsilon rather than starting at 0, which shifts where boundaries fall but doesn't avoid them. Floor was chosen only because it's marginally simpler to reason about (`[n·epsilon, (n+1)·epsilon)`); the choice between floor and round has no bearing on whether the fix is correct.

## Testing

`ranking.test.ts`: the two existing tests whose expectations encoded the old pairwise-boundary behavior were updated to match the new tier semantics (one moved off the boundary entirely to unambiguously test same-tier tying; one rewritten to document the new straddling-boundary behavior explicitly, rather than silently changing what it asserted). Added a `transitivity regression` block reproducing the exact 4-mission chain found via live testing, asserting the same four missions sort identically regardless of what order they're passed in — the property the old comparator didn't guarantee. Full suite: 226/226 passing (up from 224; net +2 in `ranking.test.ts`, from 8 to 10). `tsc --noEmit` clean.

## Consequences

- Not yet applied to the live repo or re-verified by Mico — `Proposed`, not `Accepted`, pending that.
- No schema change, no new dependency, no DB migration — this is a pure in-memory sort fix in `packages/core/src/scorer/ranking.ts`, consumed identically by `db/queries.ts` (dashboard) and anywhere else `rankMissions()` is called.
- Once applied, the dashboard's mission order should become independent of DB row-return order — worth a quick before/after glance across the 3 indexed repos to confirm the ordering now looks right, though a single visual check won't prove transitivity the way the regression test does.
- If the repo cap is raised past 3 (a documented future decision point, not scheduled), this fix is what keeps ranking correct at larger scale — it was in fact the repo cap being fully exercised, not raised, that surfaced the bug, so this is now validated at exactly the scale ADR 0007 was worried about, not just a future concern.

## Free-tier compliance

No new dependency, no new service, no schema migration. Pure algorithm fix.
