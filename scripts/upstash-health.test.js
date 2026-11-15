/**
 * scripts/upstash-health.test.js
 *
 * Unit tests for the Upstash health check logic.
 *
 * Uses a stubbed fetch implementation so no real network or secrets are
 * required. Every path through the `HealthResult` union is exercised.
 *
 * Test design mirrors scripts/ingest.test.js: vitest globals, mock at the
 * module boundary, narrow assertions on the union's discriminant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FIXED_NOW = new Date("2026-11-15T12:00:00.000Z");
const HEARTBEAT_VALUE = FIXED_NOW.toISOString();

function makeFetchStub(responses) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i++];
    if (!r) throw new Error("fetch stub exhausted");
    return {
      ok: r.ok,
      status: r.status ?? 200,
      text: async () => r.body ?? "",
      json: async () => r.json ?? { result: null },
    };
  });
}

async function importFresh() {
  vi.resetModules();
  const mod = await import("./upstash-health.mjs");
  return mod;
}

describe("checkUpstashHealth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns ok=true with latency metrics on a healthy round-trip", async () => {
    const fetch = makeFetchStub([
      { ok: true, json: { result: "PONG" } }, // PING
      { ok: true, json: { result: "OK" } }, // SET
      { ok: true, json: { result: HEARTBEAT_VALUE } }, // GET
    ]);
    const { checkUpstashHealth } = await importFresh();
    const res = await checkUpstashHealth({
      url: "https://example.upstash.io",
      token: "test-token",
      fetchImpl: fetch,
      now: () => FIXED_NOW,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.pingMs).toBe(0); // fake timers → 0 elapsed
      expect(res.latencyMs).toBe(0);
      expect(res.heartbeatKey).toBe("deptend:keepalive");
      expect(res.ttlSeconds).toBe(604800);
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("returns bad_ping when PING payload is not PONG", async () => {
    const fetch = makeFetchStub([{ ok: true, json: { result: "UNEXPECTED" } }]);
    const { checkUpstashHealth } = await importFresh();
    const res = await checkUpstashHealth({
      url: "https://example.upstash.io",
      token: "test-token",
      fetchImpl: fetch,
      now: () => FIXED_NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("bad_ping");
      expect(res.body).toContain("UNEXPECTED");
    }
  });

  it("returns invalid_credentials on HTTP 401", async () => {
    const fetch = makeFetchStub([{ ok: false, status: 401, body: "unauthorized" }]);
    const { checkUpstashHealth } = await importFresh();
    const res = await checkUpstashHealth({
      url: "https://example.upstash.io",
      token: "bad-token",
      fetchImpl: fetch,
      now: () => FIXED_NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("invalid_credentials");
      expect(res.status).toBe(401);
    }
  });

  it("returns http_error on non-2xx responses (e.g. 500, 404)", async () => {
    const fetch = makeFetchStub([{ ok: false, status: 500, body: "internal error" }]);
    const { checkUpstashHealth } = await importFresh();
    const res = await checkUpstashHealth({
      url: "https://example.upstash.io",
      token: "test-token",
      fetchImpl: fetch,
      now: () => FIXED_NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("http_error");
      expect(res.status).toBe(500);
      expect(res.body).toBe("internal error");
    }
  });

  it("returns unreachable on network failure (fetch throws)", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    const { checkUpstashHealth } = await importFresh();
    const res = await checkUpstashHealth({
      url: "https://example.upstash.io",
      token: "test-token",
      fetchImpl: fetch,
      now: () => FIXED_NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("unreachable");
      expect(res.detail).toContain("ENOTFOUND");
    }
  });

  it("returns timeout (not unreachable) when the request is aborted", async () => {
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    const fetch = vi.fn().mockRejectedValue(abortError);
    const { checkUpstashHealth } = await importFresh();
    const res = await checkUpstashHealth({
      url: "https://example.upstash.io",
      token: "test-token",
      fetchImpl: fetch,
      now: () => FIXED_NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("timeout");
      expect(res.detail).toContain("Aborted");
    }
  });

  it("returns heartbeat_write_failed when SET returns non-OK", async () => {
    const fetch = makeFetchStub([
      { ok: true, json: { result: "PONG" } },
      { ok: true, json: { result: "NOT_OK" } },
    ]);
    const { checkUpstashHealth } = await importFresh();
    const res = await checkUpstashHealth({
      url: "https://example.upstash.io",
      token: "test-token",
      fetchImpl: fetch,
      now: () => FIXED_NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("heartbeat_write_failed");
    }
  });

  it("returns heartbeat_mismatch when GET returns a different value", async () => {
    const fetch = makeFetchStub([
      { ok: true, json: { result: "PONG" } },
      { ok: true, json: { result: "OK" } },
      { ok: true, json: { result: "tampered" } },
    ]);
    const { checkUpstashHealth } = await importFresh();
    const res = await checkUpstashHealth({
      url: "https://example.upstash.io",
      token: "test-token",
      fetchImpl: fetch,
      now: () => FIXED_NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("heartbeat_mismatch");
      expect(res.expected).toBe(HEARTBEAT_VALUE);
      expect(res.actual).toBe("tampered");
    }
  });

  it("never includes the credential token in any error detail", async () => {
    const fetch = makeFetchStub([{ ok: false, status: 401, body: "unauthorized" }]);
    const { checkUpstashHealth } = await importFresh();
    const res = await checkUpstashHealth({
      url: "https://example.upstash.io",
      token: "super-secret-token-value",
      fetchImpl: fetch,
      now: () => FIXED_NOW,
    });
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain("super-secret-token-value");
  });
});

describe("formatResult (exit code + log line)", () => {
  // Regression guard: the first cut switched on `result.reason`, which is
  // absent on a healthy result (`ok: true`) — the success path matched no
  // case, printed nothing, and exited 0 silently. Verified live before the
  // fix: `node --env-file=.env.local scripts/upstash-health.mjs` → exit 0
  // with empty stdout, so the CI log never recorded an actual result.
  it("returns exitCode 0 and an OK line for a healthy result", async () => {
    const { formatResult } = await importFresh();
    const { exitCode, message } = formatResult({
      ok: true,
      latencyMs: 512,
      pingMs: 468,
      heartbeatKey: "deptend:keepalive",
      ttlSeconds: 604800,
    });
    expect(exitCode).toBe(0);
    expect(message).toContain("OK: Upstash alive");
    expect(message).toContain("ping 468 ms");
    expect(message).toContain("deptend:keepalive");
  });

  it("returns exitCode 1 with a distinct message for every failure reason", async () => {
    const { formatResult } = await importFresh();
    const cases = [
      { ok: false, reason: "missing_credentials" },
      { ok: false, reason: "invalid_credentials", status: 401 },
      { ok: false, reason: "unreachable", detail: "ENOTFOUND" },
      { ok: false, reason: "http_error", status: 404, body: "not found" },
      { ok: false, reason: "bad_ping", body: '{"result":"nope"}' },
      { ok: false, reason: "heartbeat_write_failed", status: 0, body: "WRONGTYPE" },
      { ok: false, reason: "heartbeat_mismatch", expected: "a", actual: "b" },
      { ok: false, reason: "timeout", detail: "aborted" },
    ];
    for (const c of cases) {
      const { exitCode, message } = formatResult(c);
      expect(exitCode).toBe(1);
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it("flags the archived-database cause on an HTTP error", async () => {
    const { formatResult } = await importFresh();
    const { message } = formatResult({
      ok: false,
      reason: "http_error",
      status: 404,
      body: "database not found",
    });
    expect(message).toContain("archived");
    expect(message).toContain("404");
  });
});

describe("readCredentials", () => {
  const ENV_KEYS = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
  let savedEnv = {};

  beforeEach(() => {
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
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  it("returns ok=false when both vars are missing", async () => {
    const { readCredentials } = await importFresh();
    const res = readCredentials();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("missing_credentials");
  });

  it("returns ok=false when URL is missing", async () => {
    process.env.UPSTASH_REDIS_REST_TOKEN = "has-token";
    const { readCredentials } = await importFresh();
    const res = readCredentials();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("missing_credentials");
  });

  it("returns ok=false when TOKEN is missing", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    const { readCredentials } = await importFresh();
    const res = readCredentials();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("missing_credentials");
  });

  it("returns ok=true with values when both are present", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "valid-token";
    const { readCredentials } = await importFresh();
    const res = readCredentials();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.url).toBe("https://example.upstash.io");
      expect(res.token).toBe("valid-token");
    }
  });
});
