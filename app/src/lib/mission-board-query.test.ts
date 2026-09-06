import { describe, expect, it } from "vitest";
import { clampPageNumber, isCanonicalMissionBoardQuery } from "./mission-board-query";

/**
 * `isCanonicalMissionBoardQuery` is the redirect gate for invalid URL
 * query params on /missions and /repo/[owner]/[name]. A URL is
 * "canonical" when parseMissionBoardQuery() round-trips back to itself
 * through serializeMissionBoardQuery() — i.e. none of the user's
 * values were coerced to a default. Without this gate, a deep link
 * like `?sort=easiest` (a previously-valid alias that no longer exists)
 * would render with the dropdown showing "Highest impact first" but the
 * URL still saying "easiest", and any subsequent chip click would
 * re-emit "easiest" as if it were legitimate.
 */

function rawInput(
  params: Record<string, string | undefined>,
): Parameters<typeof isCanonicalMissionBoardQuery>[0] {
  return params;
}

describe("isCanonicalMissionBoardQuery", () => {
  it("returns true for an empty URL (every field defaults)", () => {
    expect(isCanonicalMissionBoardQuery(rawInput({}))).toBe(true);
  });

  it("returns true for an already-canonical sort=quick-wins URL", () => {
    expect(isCanonicalMissionBoardQuery(rawInput({ sort: "quick-wins" }))).toBe(true);
  });

  it("returns true for a non-default page number with default filters", () => {
    expect(isCanonicalMissionBoardQuery(rawInput({ page: "3" }))).toBe(true);
  });

  it("returns true for a recognized severity set", () => {
    expect(isCanonicalMissionBoardQuery(rawInput({ severity: "critical,high" }))).toBe(true);
  });

  it("returns false when the sort is an unknown alias (e.g. legacy 'easiest')", () => {
    // `easiest` was the human-facing label ADR 0042 deprecation removed;
    // parseMissionBoardQuery falls back to "priority" but the URL keeps
    // `sort=easiest`. The redirect gate catches it.
    expect(isCanonicalMissionBoardQuery(rawInput({ sort: "easiest" }))).toBe(false);
  });

  it("treats an empty-string sort as canonical (cleaned to no sort)", () => {
    // `?sort=` parses to "priority" (the default), which serializes to
    // no sort key. The user sent nothing meaningful; the canonical form
    // is also nothing meaningful. The redirect gate does not flag this
    // — it gets silently cleaned to `/missions` on the next navigation
    // because every subsequent chip click omits the empty field.
    expect(isCanonicalMissionBoardQuery(rawInput({ sort: "" }))).toBe(true);
  });

  it("returns false when the page number is 0 or negative", () => {
    expect(isCanonicalMissionBoardQuery(rawInput({ page: "0" }))).toBe(false);
    expect(isCanonicalMissionBoardQuery(rawInput({ page: "-1" }))).toBe(false);
  });

  it("returns false when the page number is non-numeric", () => {
    expect(isCanonicalMissionBoardQuery(rawInput({ page: "abc" }))).toBe(false);
  });

  it("returns false when severity contains an unrecognized value", () => {
    // 'super-critical' isn't a Severity literal; parseSetParam filters it
    // out but leaves the rest. The serialized form would be 'critical,high'
    // (no super-critical) which differs from the raw 'critical,super-critical'.
    expect(isCanonicalMissionBoardQuery(rawInput({ severity: "critical,super-critical" }))).toBe(
      false,
    );
  });

  it("returns false when group is set to a non-'1' truthy value", () => {
    // group=0 / group=true / group=yes all coerce to false; raw URL says
    // group=0 / group=true so it disagrees with the parsed state.
    expect(isCanonicalMissionBoardQuery(rawInput({ group: "0" }))).toBe(false);
    expect(isCanonicalMissionBoardQuery(rawInput({ group: "true" }))).toBe(false);
    expect(isCanonicalMissionBoardQuery(rawInput({ group: "yes" }))).toBe(false);
  });

  it("returns true when group is omitted (no group key in URL)", () => {
    expect(isCanonicalMissionBoardQuery(rawInput({}))).toBe(true);
  });

  it("returns true when group='1' (the only canonical truthy form)", () => {
    expect(isCanonicalMissionBoardQuery(rawInput({ group: "1" }))).toBe(true);
  });

  it("returns true for an empty search query (q='', same as absent)", () => {
    // q='' and q absent both serialize to no q parameter, so they match.
    expect(isCanonicalMissionBoardQuery(rawInput({ q: "" }))).toBe(true);
  });

  it("returns true for a meaningful search query", () => {
    expect(isCanonicalMissionBoardQuery(rawInput({ q: "urllib3" }))).toBe(true);
  });

  it("returns true for a full canonical URL with multiple filters", () => {
    const canonical = isCanonicalMissionBoardQuery(
      rawInput({
        q: "certifi",
        severity: "high",
        ecosystem: "pypi",
        effort: "low",
        missionType: "vulnerability_fix",
        sort: "quick-wins",
        group: "1",
        page: "2",
      }),
    );
    expect(canonical).toBe(true);
  });

  it("agrees with serialize(parse(raw)) for valid raw inputs", () => {
    // The whole point of the function: parse → serialize round-trips
    // must produce the canonical form, and `isCanonicalMissionBoardQuery`
    // must agree. Any future default-coercion in parseMissionBoardQuery
    // will start failing this test for that field.
    const validRaw: Record<string, string> = {
      sort: "newest",
      severity: "critical,low",
      effort: "high",
      missionType: "dep_update",
      ecosystem: "go,npm",
      group: "1",
      page: "4",
      q: "crypto",
    };
    // Every field in validRaw is non-default, so the parsed-and-
    // re-serialized form is byte-equivalent to the canonical form,
    // and `isCanonicalMissionBoardQuery` returns true.
    expect(isCanonicalMissionBoardQuery(rawInput(validRaw))).toBe(true);
  });
});

describe("clampPageNumber", () => {
  it("returns the page unchanged when it is in range", () => {
    expect(clampPageNumber(1, 4)).toBe(1);
    expect(clampPageNumber(2, 4)).toBe(2);
    expect(clampPageNumber(4, 4)).toBe(4);
  });

  it("clamps a page past the end down to the last valid page", () => {
    expect(clampPageNumber(99, 4)).toBe(4);
  });

  it("clamps a page below 1 up to 1", () => {
    // parseMissionBoardQuery coerces non-positive page inputs to 1 before
    // they reach the page handler, but the clamp is the last line of
    // defense for any caller that bypasses the parser.
    expect(clampPageNumber(0, 4)).toBe(1);
    expect(clampPageNumber(-1, 4)).toBe(1);
  });

  it("floors an empty board at pageCount=1 so the UI still has a valid 'page 1 of 1' state", () => {
    expect(clampPageNumber(1, 0)).toBe(1);
  });

  it("ignores a negative pageCount — a degenerate count falls back to 1", () => {
    expect(clampPageNumber(99, -3)).toBe(1);
  });
});
