#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/upstash-health.mjs
 *
 * Upstash rate-limit database liveness + keepalive check.
 *
 * Prevents the free-tier DB from being archived after >=30 idle days
 * (Upstash policy: free databases with no activity for 30+ days are
 * archived; an archived DB causes all rate-limit checks to fail open,
 * silently disabling abuse protection). Runs every 6 hours via
 * `.github/workflows/health-check.yml` to guarantee continuous activity
 * and to fail loudly (email alert) if the DB is unreachable.
 *
 * Also serves as a manual verification tool:
 *   node --env-file=.env.local scripts/upstash-health.mjs
 *
 * Usage in CI (GitHub Actions):
 *   - env vars supplied from secrets: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *   - no dotenv dependency — Node 20.6+ `--env-file` flag used locally
 *
 * Exit codes:
 *   0  healthy — DB reachable, write + read round-trip succeeded
 *   1  unhealthy — missing credentials, auth failure, DB unreachable,
 *      or round-trip mismatch (never prints credential values)
 *
 * Reads credentials from process.env only.
 */

import { pathToFileURL } from "node:url";

/**
 * @typedef {{ ok: true, url: string, token: string } | { ok: false, reason: "missing_credentials" }} CredentialsResult
 */

/** Result of reading the two required environment variables. */
function readCredentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url === undefined || url === "" || token === undefined || token === "") {
    return { ok: false, reason: "missing_credentials" };
  }
  return { ok: true, url, token };
}

/**
 * @typedef {{
 *   ok: true,
 *   latencyMs: number,
 *   pingMs: number,
 *   heartbeatKey: string,
 *   ttlSeconds: number
 * }} HealthOk
 *
 * @typedef {{
 *   ok: false,
 *   reason: "missing_credentials"
 * } | {
 *   ok: false,
 *   reason: "invalid_credentials",
 *   status: number
 * } | {
 *   ok: false,
 *   reason: "unreachable",
 *   detail: string
 * } | {
 *   ok: false,
 *   reason: "http_error",
 *   status: number,
 *   body: string
 * } | {
 *   ok: false,
 *   reason: "bad_ping",
 *   body: string
 * } | {
 *   ok: false,
 *   reason: "heartbeat_write_failed",
 *   status: number,
 *   body: string
 * } | {
 *   ok: false,
 *   reason: "heartbeat_mismatch",
 *   expected: string,
 *   actual: string
 * } | {
 *   ok: false,
 *   reason: "timeout",
 *   detail: string
 * }} HealthErr
 *
 * @typedef {HealthOk | HealthErr} HealthResult
 */

/**
 * Perform a full liveness check against an Upstash Redis REST endpoint.
 *
 * @param {{
 *   url: string,
 *   token: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   now?: () => Date
 * }} opts
 * @returns {Promise<HealthResult>}
 */
async function checkUpstashHealth(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10000;
  const now = opts.now ?? (() => new Date());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const { url, token } = opts;

  /** Build a command payload for the Upstash REST batch endpoint. */
  function cmd(...args) {
    return args;
  }

  async function doRequest(body) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, status: res.status, body: text };
      }
      const json = await res.json().catch(() => ({ result: null }));
      return { ok: true, json };
    } catch (err) {
      if (err.name === "AbortError" || err.name === "TimeoutError") {
        return { ok: false, reason: "timeout", detail: String(err) };
      }
      return { ok: false, reason: "unreachable", detail: String(err) };
    }
  }

  // 1) PING
  const pingStart = now().getTime();
  const pingRes = await doRequest(cmd("PING"));
  const pingMs = now().getTime() - pingStart;
  if (!pingRes.ok) {
    clearTimeout(timer);
    if (pingRes.status === 401) {
      return { ok: false, reason: "invalid_credentials", status: 401 };
    }
    if (pingRes.reason === "unreachable") {
      return { ok: false, reason: "unreachable", detail: pingRes.detail };
    }
    if (pingRes.reason === "timeout") {
      return { ok: false, reason: "timeout", detail: pingRes.detail };
    }
    return { ok: false, reason: "http_error", status: pingRes.status, body: pingRes.body };
  }
  if (pingRes.json.result !== "PONG") {
    clearTimeout(timer);
    return { ok: false, reason: "bad_ping", body: JSON.stringify(pingRes.json) };
  }

  // 2) SET heartbeat key (7-day TTL) — proves write access works
  const heartbeatKey = "deptend:keepalive";
  const heartbeatValue = now().toISOString();
  const setRes = await doRequest(cmd("SET", heartbeatKey, heartbeatValue, "EX", "604800"));
  if (!setRes.ok) {
    clearTimeout(timer);
    if (setRes.reason === "unreachable") {
      return { ok: false, reason: "unreachable", detail: setRes.detail };
    }
    if (setRes.reason === "timeout") {
      return { ok: false, reason: "timeout", detail: setRes.detail };
    }
    return {
      ok: false,
      reason: "heartbeat_write_failed",
      status: setRes.status,
      body: setRes.body,
    };
  }
  if (setRes.json.result !== "OK") {
    clearTimeout(timer);
    return {
      ok: false,
      reason: "heartbeat_write_failed",
      status: 0,
      body: JSON.stringify(setRes.json),
    };
  }

  // 3) GET heartbeat key — proves read access + data integrity
  const getRes = await doRequest(cmd("GET", heartbeatKey));
  if (!getRes.ok) {
    clearTimeout(timer);
    if (getRes.reason === "unreachable") {
      return { ok: false, reason: "unreachable", detail: getRes.detail };
    }
    if (getRes.reason === "timeout") {
      return { ok: false, reason: "timeout", detail: getRes.detail };
    }
    return {
      ok: false,
      reason: "http_error",
      status: getRes.status,
      body: getRes.body,
    };
  }
  if (getRes.json.result !== heartbeatValue) {
    clearTimeout(timer);
    return {
      ok: false,
      reason: "heartbeat_mismatch",
      expected: heartbeatValue,
      actual: String(getRes.json.result ?? "null"),
    };
  }

  clearTimeout(timer);
  const latencyMs = now().getTime() - pingStart;
  return {
    ok: true,
    latencyMs,
    pingMs,
    heartbeatKey,
    ttlSeconds: 604800,
  };
}

function fatal(message) {
  console.error(`[upstash-health] ${message}`);
  process.exit(1);
}

/**
 * Map a HealthResult to the exact log line the workflow prints and the
 * process exit code the workflow's `if: failure()` email step keys on.
 *
 * Kept as a pure function (no console / no process.exit) so the success
 * line and every failure message are covered by unit tests — the earlier
 * `switch (result.reason)` shape silently printed nothing on success and
 * exited 0, because the healthy result carries `ok: true`, not
 * `reason: "ok"`. Never include credential values in these messages.
 *
 * @param {HealthResult} result
 * @returns {{ exitCode: number, message: string }}
 */
function formatResult(result) {
  if (result.ok) {
    return {
      exitCode: 0,
      message:
        `OK: Upstash alive (ping ${result.pingMs} ms, round-trip ` +
        `${result.latencyMs} ms, key ${result.heartbeatKey} ttl ${result.ttlSeconds} s)`,
    };
  }

  switch (result.reason) {
    case "missing_credentials":
      return {
        exitCode: 1,
        message: "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set",
      };
    case "invalid_credentials":
      return { exitCode: 1, message: "invalid credentials (HTTP 401)" };
    case "unreachable":
      return { exitCode: 1, message: `unreachable: ${result.detail}` };
    case "http_error":
      return {
        exitCode: 1,
        message:
          `HTTP ${result.status} — the database may be archived (Upstash archives ` +
          `free databases after >=30 idle days): ${result.body}`,
      };
    case "bad_ping":
      return { exitCode: 1, message: `unexpected PING response: ${result.body}` };
    case "heartbeat_write_failed":
      return {
        exitCode: 1,
        message:
          `heartbeat SET failed (HTTP ${result.status}) — a read-only token cannot ` +
          `rate limit: ${result.body}`,
      };
    case "heartbeat_mismatch":
      return {
        exitCode: 1,
        message: `heartbeat read mismatch: expected ${result.expected}, got ${result.actual}`,
      };
    case "timeout":
      return { exitCode: 1, message: `timed out: ${result.detail}` };
  }
}

async function main() {
  const creds = readCredentials();
  const result = creds.ok
    ? await checkUpstashHealth(creds)
    : { ok: false, reason: "missing_credentials" };

  const { exitCode, message } = formatResult(result);
  if (exitCode === 0) {
    console.log(message);
    process.exit(0);
  }
  fatal(message);
}

// Gate execution on direct run (same pattern as scripts/ingest.js)
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}

export { checkUpstashHealth, readCredentials, formatResult };
