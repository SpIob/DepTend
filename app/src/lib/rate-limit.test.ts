/**
 * Rate limiter unit tests.
 *
 * createRateLimiter() returns a sliding-window counter keyed by an
 * arbitrary string (GitHub login, in this project's real callers). Time
 * is controlled with vitest's fake timers rather than real sleeps, since
 * the limiter reads Date.now() directly with no injectable clock.
 *
 * checkRepoSubmissionLimit and checkMissionActionLimit are module-level
 * singletons with no reset mechanism (by design — mirrors the real,
 * never-cleared production Map). Every test against them uses a unique
 * key so tests can't leak state into each other; a fixed key reused
 * across tests would accumulate hits from earlier tests in this file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkMissionActionLimit, checkRepoSubmissionLimit, createRateLimiter } from "./rate-limit";

const FIXED_NOW = new Date("2026-07-28T00:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createRateLimiter", () => {
  it("allows requests up to the limit", () => {
    const check = createRateLimiter(3, 1000);
    expect(check("user-a")).toEqual({ allowed: true });
    expect(check("user-a")).toEqual({ allowed: true });
    expect(check("user-a")).toEqual({ allowed: true });
  });

  it("blocks the request that exceeds the limit", () => {
    const check = createRateLimiter(3, 1000);
    check("user-a");
    check("user-a");
    check("user-a");
    expect(check("user-a").allowed).toBe(false);
  });

  it("enforces limit = 1 correctly", () => {
    const check = createRateLimiter(1, 5000);
    expect(check("solo")).toEqual({ allowed: true });
    expect(check("solo").allowed).toBe(false);
  });

  it("tracks separate keys independently", () => {
    const check = createRateLimiter(1, 60_000);
    expect(check("user-a")).toEqual({ allowed: true });
    expect(check("user-b")).toEqual({ allowed: true });
    expect(check("user-a").allowed).toBe(false);
    expect(check("user-b").allowed).toBe(false);
  });

  it("computes retryAfterSeconds from the oldest hit still in the window", () => {
    const check = createRateLimiter(2, 10_000);
    check("user-a"); // hit at t=0
    vi.advanceTimersByTime(4000);
    check("user-a"); // hit at t=4000
    vi.advanceTimersByTime(1000); // now t=5000, both hits still in window
    const result = check("user-a");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // oldest hit (t=0) expires at t=10000; 5000ms left -> 5s
      expect(result.retryAfterSeconds).toBe(5);
    }
  });

  it("never reports retryAfterSeconds below 1, even a moment before expiry", () => {
    const check = createRateLimiter(1, 1000);
    check("user-a"); // hit at t=0
    vi.advanceTimersByTime(999); // 1ms shy of the window closing
    const result = check("user-a");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterSeconds).toBe(1);
    }
  });

  it("frees capacity once every hit has aged out of the window", () => {
    const check = createRateLimiter(2, 10_000);
    check("user-a");
    check("user-a");
    expect(check("user-a").allowed).toBe(false);

    vi.advanceTimersByTime(10_001);
    expect(check("user-a")).toEqual({ allowed: true });
  });

  it("frees exactly one slot as its hit ages out, not the whole window", () => {
    const check = createRateLimiter(2, 10_000);
    check("user-a"); // hit at t=0
    vi.advanceTimersByTime(8000);
    check("user-a"); // hit at t=8000
    vi.advanceTimersByTime(3000); // now t=11000: only the t=0 hit has aged out

    expect(check("user-a")).toEqual({ allowed: true }); // refills the freed slot
    expect(check("user-a").allowed).toBe(false); // back at the limit
  });
});

describe("block logging (added 2026-08-06)", () => {
  it("logs a single console.warn with the label on block, and not before", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const check = createRateLimiter(1, 5000, "test-label");

    check("user-a");
    expect(warnSpy).not.toHaveBeenCalled();

    check("user-a");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("label=test-label");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("key=user-a");

    warnSpy.mockRestore();
  });

  it("does not log anything for requests that stay under the limit", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const check = createRateLimiter(3, 5000, "test-label");

    check("user-b");
    check("user-b");
    check("user-b");
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("defaults to label='rate-limit' when none is passed", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const check = createRateLimiter(1, 5000);

    check("user-c");
    check("user-c");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("label=rate-limit");

    warnSpy.mockRestore();
  });
});

describe("checkRepoSubmissionLimit", () => {
  it("allows 5 submissions per hour then blocks the 6th", () => {
    const key = `repo-test-${crypto.randomUUID()}`;
    for (let i = 0; i < 5; i++) {
      expect(checkRepoSubmissionLimit(key).allowed).toBe(true);
    }
    expect(checkRepoSubmissionLimit(key).allowed).toBe(false);
  });

  it("frees up once the full hour window elapses", () => {
    const key = `repo-test-${crypto.randomUUID()}`;
    for (let i = 0; i < 5; i++) checkRepoSubmissionLimit(key);
    expect(checkRepoSubmissionLimit(key).allowed).toBe(false);

    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(checkRepoSubmissionLimit(key).allowed).toBe(true);
  });
});

describe("checkMissionActionLimit", () => {
  it("allows 20 claim/unclaim actions per minute then blocks the 21st", () => {
    const key = `mission-test-${crypto.randomUUID()}`;
    for (let i = 0; i < 20; i++) {
      expect(checkMissionActionLimit(key).allowed).toBe(true);
    }
    expect(checkMissionActionLimit(key).allowed).toBe(false);
  });

  it("shares one budget across claim and unclaim for the same user", () => {
    // The claim and unclaim routes both call this same singleton keyed on
    // login — there's no separate bucket per action type, by design.
    const key = `mission-test-${crypto.randomUUID()}`;
    for (let i = 0; i < 20; i++) checkMissionActionLimit(key);
    expect(checkMissionActionLimit(key).allowed).toBe(false);
  });

  it("frees up once the full minute window elapses", () => {
    const key = `mission-test-${crypto.randomUUID()}`;
    for (let i = 0; i < 20; i++) checkMissionActionLimit(key);
    expect(checkMissionActionLimit(key).allowed).toBe(false);

    vi.advanceTimersByTime(60 * 1000 + 1);
    expect(checkMissionActionLimit(key).allowed).toBe(true);
  });
});
