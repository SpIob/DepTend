/**
 * Mission ranking
 *
 * Sorts scored missions by composite_score descending. Missions that land
 * in the same COMPOSITE_TIE_EPSILON-wide tier are treated as tied and
 * broken by effort_label ascending (prefer the easier win), then by the
 * tied advisory's published_at descending (newest known vulnerability
 * first), then by osv_id as an absolute, always-unique final fallback.
 *
 * Ties are resolved by bucketing composite_score into fixed-width tiers
 * (compositeTier() below) rather than by comparing each pair's distance
 * directly. An earlier version did pairwise |a - b| <= epsilon comparison
 * inside the sort comparator itself — ADR 0007 §7 flagged at the time that
 * this isn't transitive (A≈B and B≈C doesn't guarantee A≈C), and noted it
 * "isn't worth the extra complexity of clustering ties" while the 3-repo
 * MVP cap kept mission lists small. That assumption stopped holding once
 * 3 real repos were actually indexed: a long-enough chain of near-equal
 * scores made the old comparator input-order-dependent — the same set of
 * missions could sort differently depending on what order they came back
 * from the DB in. Bucketing first makes "tied" a real equivalence class
 * (same tier) instead of a fuzzy pairwise distance, which is what
 * guarantees a consistent order regardless of input order. See ADR 0017.
 *
 * The final tie-break used to be the mission row's own created_at. That
 * turned out not to discriminate at all for missions created together in
 * one ingestion run: Postgres' now() (what Drizzle's .defaultNow() uses)
 * is fixed for the lifetime of a transaction, and MissionWriter writes an
 * entire repo's missions in one transaction — so every mission from the
 * same run shared one identical created_at. The CLI had the same failure
 * mode even more visibly (one JS Date reused across an entire run, no
 * transaction needed to cause it). Replaced with the advisory's own
 * published_at, which has real per-advisory granularity independent of
 * when DepTend happened to ingest it, plus osv_id as a guaranteed-unique
 * absolute fallback. See ADR 0018.
 *
 * ADR: docs/adr/0006-scoring-algorithm.md,
 *      docs/adr/0017-ranking-tie-break-transitivity-fix.md,
 *      docs/adr/0018-ranking-final-tie-break-published-at.md
 */

import type { EffortLabel } from "../db/schema.js";

const COMPOSITE_TIE_EPSILON = 0.5;

export interface RankableMission {
  /**
   * Final tie-break inputs — deliberately not the mission row's own
   * created_at. See the module docstring / ADR 0018 for why.
   */
  tie_break: {
    /** The tied advisory's published_at, when known. Newer sorts first. */
    published_at: Date | null;
    /** Absolute last-resort, always-unique, always-present fallback. */
    osv_id: string;
  };
  score: {
    composite_score: number;
    effort_label: EffortLabel;
  };
}

function effortRank(label: EffortLabel): number {
  switch (label) {
    case "trivial":
      return 0;
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
    default:
      throw new Error(`Unhandled effort label: ${String(label)}`);
  }
}

/**
 * Buckets composite_score into fixed COMPOSITE_TIE_EPSILON-wide tiers, e.g.
 * with epsilon 0.5: [5.0, 5.5) -> tier 10, [5.5, 6.0) -> tier 11, etc.
 * Two scores are "tied" iff they land in the same tier — a real, transitive
 * equivalence class, unlike a pairwise |a - b| <= epsilon check. The
 * trade-off: two scores that straddle a tier boundary (e.g. 7.49 and 7.5)
 * are no longer treated as tied even though they're numerically close —
 * necessary for a consistent ordering, not a bug. See ADR 0017.
 */
function compositeTier(score: number): number {
  return Math.floor(score / COMPOSITE_TIE_EPSILON);
}

/** Returns a new, sorted array — does not mutate the input. */
export function rankMissions<T extends RankableMission>(missions: readonly T[]): T[] {
  return [...missions].sort((a, b) => {
    const tierDiff =
      compositeTier(b.score.composite_score) - compositeTier(a.score.composite_score);
    if (tierDiff !== 0) {
      return tierDiff; // higher tier (composite_score) first
    }

    const effortDiff = effortRank(a.score.effort_label) - effortRank(b.score.effort_label);
    if (effortDiff !== 0) {
      return effortDiff; // easier effort first
    }

    // Newest known vulnerability first. A missing published_at (rare)
    // sorts as if it were infinitely old, so it falls after any advisory
    // with a real date rather than arbitrarily jumping the queue.
    const aTime = a.tie_break.published_at?.getTime() ?? Number.NEGATIVE_INFINITY;
    const bTime = b.tie_break.published_at?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (aTime !== bTime) {
      return bTime - aTime; // descending: newer first
    }

    // Absolute final fallback: guaranteed unique, guaranteed deterministic.
    return a.tie_break.osv_id.localeCompare(b.tie_break.osv_id);
  });
}
