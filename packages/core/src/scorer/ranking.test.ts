/**
 * rankMissions unit tests — covers the ADR 0006 tie-break rule: composite
 * score descending, ties within 0.5 broken by effort_label ascending, then
 * created_at ascending.
 */

import { describe, expect, it } from "vitest";
import { rankMissions, type RankableMission } from "./ranking.js";
import type { EffortLabel } from "../db/types.js";

function makeMission(
  composite_score: number,
  effort_label: EffortLabel,
  created_at: string,
): RankableMission {
  return { created_at: new Date(created_at), score: { composite_score, effort_label } };
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

  it("treats scores within 0.5 of each other as tied and breaks by effort_label ascending", () => {
    const easier = makeMission(7.2, "trivial", "2026-01-01");
    const harder = makeMission(7.5, "high", "2026-01-01");
    const ranked = rankMissions([harder, easier]);
    // 0.3 apart -> tied -> trivial (easier) should win despite the lower raw score
    expect(ranked[0]).toBe(easier);
    expect(ranked[1]).toBe(harder);
  });

  it("does not treat scores exactly at the epsilon boundary as tied (diff must exceed epsilon)", () => {
    const higher = makeMission(8.0, "high", "2026-01-01");
    const lower = makeMission(7.5, "trivial", "2026-01-01"); // exactly 0.5 apart
    const ranked = rankMissions([lower, higher]);
    // diff of exactly 0.5 is NOT > epsilon, so still tied -> effort breaks it
    expect(ranked[0]).toBe(lower);
  });

  it("falls back to created_at ascending when both score and effort_label tie", () => {
    const earlier = makeMission(5.0, "medium", "2026-01-01T00:00:00Z");
    const later = makeMission(5.1, "medium", "2026-02-01T00:00:00Z");
    const ranked = rankMissions([later, earlier]);
    expect(ranked[0]).toBe(earlier);
    expect(ranked[1]).toBe(later);
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
});
