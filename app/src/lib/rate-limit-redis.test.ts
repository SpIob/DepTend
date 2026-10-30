/**
 * rate-limit-redis.ts unit tests — the failure-mode fixes (TASK-02).
 *
 * rate-limit.test.ts exercises the in-memory fallback through the real
 * module singletons; these tests cover what that file can't reach: the Redis
 * path and the lazy initialization. vi.resetModules() gives each test a
 * fresh cold instance so the UPSTASH_REDIS_REST_* env vars can be set or
 * deleted per test (saved and restored around each change). @upstash/ratelimit
 * and @upstash/redis are mocked at the module boundary — the real
 * Ratelimit.limit() talks to Upstash over HTTP and returns { success, reset },
 * so a thrown error is the only way to exercise the fail-open catch here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter, type RateLimitResult } from "./rate-limit-redis";

const { limitFn } = vi.hoisted(() => ({
  limitFn: vi.fn<(identifier: string) => Promise<{ success: boolean; reset: number }>>(),
}));

vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    static slidingWindow(maxTokens: number, window: string): { maxTokens: number; window: string } {
      return { maxTokens, window };
    }
    limit = limitFn;
  }
  return { Ratelimit };
});

vi.mock("@upstash/redis", () => {
  return { Redis: vi.fn() };
});

const ENV_KEYS = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const;
const FIXED_NOW = new Date("2026-07-28T00:00:00.000Z");
const REDIS_URL = "https://example.upstash.io";
const REDIS_TOKEN = "test-token";

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  limitFn.mockReset();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      savedEnv[key] = value;
    }
    Reflect.deleteProperty(process.env, key);
  }
});

afterEach(() => {
  vi.useRealTimers();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  vi.restoreAllMocks();
});

async function importFresh(): Promise<typeof import("./rate-limit-redis")> {
  vi.resetModules();
  return import("./rate-limit-redis");
}

describe("Redis-error fail-open (deliberate decision — TASK-02)", () => {
  it("returns allowed and logs when Ratelimit.limit throws (repo submission)", async () => {
    process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = REDIS_TOKEN;
    const { checkRepoSubmissionLimit } = await importFresh();

    limitFn.mockRejectedValue(new Error("Upstash outage"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(checkRepoSubmissionLimit("user-a")).resolves.toEqual({ allowed: true });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("kind=repo-submission");
    expect(errorSpy.mock.calls[0]?.[0]).toContain("failing open");
  });

  it("returns allowed and logs when Ratelimit.limit throws (mission action)", async () => {
    process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = REDIS_TOKEN;
    const { checkMissionActionLimit } = await importFresh();

    limitFn.mockRejectedValue(new Error("network error"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(checkMissionActionLimit("user-a")).resolves.toEqual({ allowed: true });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("kind=mission-action");
  });

  it("maps a Redis 429-shaped denial to allowed:false with Retry-After seconds", async () => {
    process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = REDIS_TOKEN;
    const { checkRepoSubmissionLimit } = await importFresh();

    const reset = Date.now() + 10_000;
    limitFn.mockResolvedValue({ success: false, reset });

    await expect(checkRepoSubmissionLimit("user-a")).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 10,
    });
  });
});

describe("lazy initialization (replaces module-load init — TASK-02)", () => {
  it("uses the in-memory fallback when env vars are absent, then the Redis path on a fresh cold instance with them set", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const first = await importFresh();
    for (let i = 0; i < 5; i++) {
      await expect(first.checkRepoSubmissionLimit("cold-user")).resolves.toEqual({
        allowed: true,
      });
    }
    await expect(first.checkRepoSubmissionLimit("cold-user")).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 3600,
    });
    expect(limitFn).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((call) => call[0]?.includes("falling back"))).toBe(true);

    process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = REDIS_TOKEN;
    limitFn.mockResolvedValue({ success: true, reset: Date.now() + 60_000 });

    const second = await importFresh();
    await expect(second.checkRepoSubmissionLimit("cold-user")).resolves.toEqual({
      allowed: true,
    });
    expect(limitFn).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls.some((call) => call[0]?.includes("Upstash Redis"))).toBe(true);
  });

  it("does not construct the Redis path at import time — only on first use", async () => {
    process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = REDIS_TOKEN;
    limitFn.mockResolvedValue({ success: true, reset: Date.now() + 60_000 });

    const mod = await importFresh();
    expect(limitFn).not.toHaveBeenCalled();

    await expect(mod.checkRepoSubmissionLimit("lazy-user")).resolves.toEqual({ allowed: true });
    expect(limitFn).toHaveBeenCalledTimes(1);
  });
});

describe("fallback Map eviction cap (TASK-02)", () => {
  it("drops expired entries when inserting a new key past the cap", () => {
    const check = createEvictionLimiter();

    for (let i = 0; i < 10_000; i++) {
      expect(check(`fill-${String(i)}`).allowed).toBe(true);
    }

    vi.advanceTimersByTime(60_001);

    const deleteSpy = vi.spyOn(Map.prototype, "delete");
    expect(check("trigger").allowed).toBe(true);
    expect(deleteSpy.mock.calls.length).toBe(10_000);
    deleteSpy.mockRestore();
  });

  it("keeps entries whose newest hit is still inside the window when the cap is hit", () => {
    const check = createEvictionLimiter();

    for (let i = 0; i < 10_000; i++) {
      check(`fill-${String(i)}`);
    }

    vi.advanceTimersByTime(30_000);

    const deleteSpy = vi.spyOn(Map.prototype, "delete");
    expect(check("trigger").allowed).toBe(true);
    expect(deleteSpy).not.toHaveBeenCalled();
    deleteSpy.mockRestore();
  });
});

function createEvictionLimiter(): (key: string) => RateLimitResult {
  return createRateLimiter(1, 60_000, "eviction-test");
}

describe("in-memory fallback still blocks over-limit keys (existing behavior)", () => {
  it("blocks the 6th repo submission in a fresh cold instance with env vars absent", async () => {
    const mod = await importFresh();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    for (let i = 0; i < 5; i++) {
      await expect(mod.checkRepoSubmissionLimit("fallback-user")).resolves.toEqual({
        allowed: true,
      });
    }
    const result = await mod.checkRepoSubmissionLimit("fallback-user");
    expect(result.allowed).toBe(false);
    expect(limitFn).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("blocks the 21st mission action in a fresh cold instance with env vars absent", async () => {
    const mod = await importFresh();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    for (let i = 0; i < 20; i++) {
      await expect(mod.checkMissionActionLimit("fallback-user")).resolves.toEqual({
        allowed: true,
      });
    }
    const result = await mod.checkMissionActionLimit("fallback-user");
    expect(result.allowed).toBe(false);
    expect(limitFn).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
