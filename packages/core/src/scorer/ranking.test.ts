/**
 * rankMissions unit tests — covers the ADR 0006 tie-break rule: composite
 * score descending, ties within the same 0.5-wide tier broken by
 * effort_label ascending. Also covers the ADR 0017 transitivity fix (see
 * the "regression" tests at the bottom) and the ADR 0018 final tie-break
 * (published_at descending, then osv_id as an absolute fallback).
 */

import { describe, expect, it } from "vitest";
import { rankMissions, type RankableMission } from "./ranking.js";
import type { EffortLabel } from "../db/schema.js";

function makeMission(
  composite_score: number,
  effort_label: EffortLabel,
  published_at: string | null,
  osv_id = "GHSA-default",
): RankableMission {
  return {
    tie_break: { published_at: published_at === null ? null : new Date(published_at), osv_id },
    score: { composite_score, effort_label },
  };
}

describe("rankMissions", () => {
  it("sorts by composite_score descending when scores are clearly apart", () => {
    const missions = [
      makeMission(3.0, "medium", "2026-01-01"),
      makeMission(9.0, "medium", "2026-01-01"),
      makeMission(6.0, "medium", "2026-01-01"),
    ];
    const ranked = rankMissions(missions);
    expect(ranked.map((m) => m.score.composite_score)).toEqual([9.0, 6.0, 3.0]);
  });

  it("treats scores in the same 0.5-wide tier as tied and breaks by effort_label ascending", () => {
    const easier = makeMission(7.1, "trivial", "2026-01-01"); // tier floor(7.1/0.5) = 14
    const harder = makeMission(7.4, "high", "2026-01-01"); // tier floor(7.4/0.5) = 14, same tier
    const ranked = rankMissions([harder, easier]);
    expect(ranked[0]).toBe(easier);
    expect(ranked[1]).toBe(harder);
  });

  it("treats scores that straddle a tier boundary as NOT tied, even when numerically close (ADR 0017)", () => {
    const justBelow = makeMission(7.49, "trivial", "2026-01-01"); // tier floor(14.98) = 14
    const atBoundary = makeMission(7.5, "high", "2026-01-01"); // tier floor(15.0) = 15
    const ranked = rankMissions([justBelow, atBoundary]);
    // Different tiers despite being 0.01 apart -> not tied -> pure composite_score order
    expect(ranked[0]).toBe(atBoundary);
    expect(ranked[1]).toBe(justBelow);
  });

  it("orders all four effort labels correctly when scores are tied", () => {
    const high = makeMission(5.0, "high", "2026-01-01");
    const medium = makeMission(5.0, "medium", "2026-01-01");
    const low = makeMission(5.0, "low", "2026-01-01");
    const trivial = makeMission(5.0, "trivial", "2026-01-01");
    const ranked = rankMissions([high, medium, low, trivial]);
    expect(ranked).toEqual([trivial, low, medium, high]);
  });

  it("does not mutate the input array", () => {
    const missions = [
      makeMission(1.0, "medium", "2026-01-01"),
      makeMission(9.0, "medium", "2026-01-01"),
    ];
    const original = [...missions];
    rankMissions(missions);
    expect(missions).toEqual(original);
  });

  it("returns an empty array for an empty input", () => {
    expect(rankMissions([])).toEqual([]);
  });

  it("handles a single mission", () => {
    const mission = makeMission(5.0, "medium", "2026-01-01");
    expect(rankMissions([mission])).toEqual([mission]);
  });

  describe("final tie-break: published_at, then osv_id (ADR 0018)", () => {
    it("falls back to published_at descending (newest first) when score and effort both tie", () => {
      const older = makeMission(5.0, "medium", "2026-01-01T00:00:00Z");
      const newer = makeMission(5.1, "medium", "2026-02-01T00:00:00Z"); // same tier (10) as 5.0
      const ranked = rankMissions([older, newer]);
      expect(ranked[0]).toBe(newer);
      expect(ranked[1]).toBe(older);
    });

    it("falls back to osv_id ascending when published_at also ties", () => {
      const b = makeMission(5.0, "medium", "2026-01-01", "GHSA-bbbb");
      const a = makeMission(5.0, "medium", "2026-01-01", "GHSA-aaaa");
      const ranked = rankMissions([b, a]);
      expect(ranked[0]).toBe(a);
      expect(ranked[1]).toBe(b);
    });

    it("sorts a null published_at after any mission with a known date, not arbitrarily first", () => {
      const unknown = makeMission(5.0, "medium", null, "GHSA-unknown");
      const known = makeMission(5.0, "medium", "2020-01-01", "GHSA-known"); // very old, still a real date
      const ranked = rankMissions([unknown, known]);
      expect(ranked[0]).toBe(known);
      expect(ranked[1]).toBe(unknown);
    });

    it("breaks a tie between two null published_at missions by osv_id", () => {
      const b = makeMission(5.0, "medium", null, "GHSA-bbbb");
      const a = makeMission(5.0, "medium", null, "GHSA-aaaa");
      const ranked = rankMissions([b, a]);
      expect(ranked[0]).toBe(a);
      expect(ranked[1]).toBe(b);
    });
  });

  describe("transitivity regression (ADR 0017)", () => {
    // A chain where each adjacent pair is 0.4 apart (within the old
    // pairwise epsilon) but the ends are 1.2 apart. Reproduced against
    // the pre-fix comparator: [A,B,C,D] and [D,C,B,A] both sorted to
    // ascending composite_score order via cascading effort tie-breaks,
    // but [B,D,A,C] sorted to a third, inconsistent order — proving the
    // old comparator wasn't a valid total order. This only surfaced with
    // enough missions in play to form a long-enough chain, which is why
    // it didn't show up against the single 2-dependency Phase 2 fixture.
    const a = makeMission(6.5, "high", "2026-01-01"); // tier floor(13.0) = 13
    const b = makeMission(6.1, "medium", "2026-01-01"); // tier floor(12.2) = 12
    const c = makeMission(5.7, "low", "2026-01-01"); // tier floor(11.4) = 11
    const d = makeMission(5.3, "trivial", "2026-01-01"); // tier floor(10.6) = 10

    it("sorts a chain of near-equal scores by raw composite_score once tiers separate them", () => {
      const ranked = rankMissions([a, b, c, d]);
      expect(ranked.map((m) => m.score.composite_score)).toEqual([6.5, 6.1, 5.7, 5.3]);
    });

    it("produces the same order regardless of input order", () => {
      const expected = [6.5, 6.1, 5.7, 5.3];
      expect(rankMissions([a, b, c, d]).map((m) => m.score.composite_score)).toEqual(expected);
      expect(rankMissions([d, c, b, a]).map((m) => m.score.composite_score)).toEqual(expected);
      expect(rankMissions([b, d, a, c]).map((m) => m.score.composite_score)).toEqual(expected);
      expect(rankMissions([c, a, d, b]).map((m) => m.score.composite_score)).toEqual(expected);
    });
  });

  describe("real-world regression: many missions tied on tier and effort (2026-07-18)", () => {
    // Reproduces the actual shape of the bug found cross-validating the CLI
    // against the live dashboard for SpIob/StockWatch: 12 vite/postcss
    // missions all landed in the same tier with the same effort label.
    // Under the old created_at tie-break (fabricated identically for every
    // mission in one CLI run, and identically for every mission in one DB
    // transaction on the dashboard side), this whole group's relative
    // order was arbitrary and input-order-dependent. published_at gives
    // each one a real, distinguishing value.
    it("produces a stable, newest-first order across a large tied group regardless of input order", () => {
      const missions = [
        makeMission(1.48, "high", "2024-03-01", "GHSA-a"),
        makeMission(1.48, "high", "2025-11-15", "GHSA-b"),
        makeMission(1.48, "high", "2022-06-20", "GHSA-c"),
        makeMission(1.48, "high", "2025-11-15", "GHSA-d"), // ties with GHSA-b on date
        makeMission(1.48, "high", "2023-01-10", "GHSA-e"),
      ];
      const expectedOrder = ["GHSA-b", "GHSA-d", "GHSA-a", "GHSA-e", "GHSA-c"];

      const ranked1 = rankMissions(missions);
      const ranked2 = rankMissions([...missions].reverse());

      expect(ranked1.map((m) => m.tie_break.osv_id)).toEqual(expectedOrder);
      expect(ranked2.map((m) => m.tie_break.osv_id)).toEqual(expectedOrder);
    });
  });
});
