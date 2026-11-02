/**
 * Tests bounding the timing store's growth (2026-11-02 perf audit).
 *
 * The store is a module-level Map keyed by request id; in production only
 * /missions reads entries back, yet withTiming records on every page, so
 * without these guards one Map entry per request would live for the
 * process lifetime. Two behaviors under test: getOrCreateStore's cap
 * (MAX_STORED_REQUESTS, oldest-inserted eviction) and logTimingsForRequest's
 * delete-after-final-read on both the production early-return path and the
 * deferred "full" flush pass.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

import { headers } from "next/headers";
import {
  _resetForTests,
  deleteStore,
  getOrCreateStore,
  MAX_STORED_REQUESTS,
  readEntries,
  stores,
} from "./store";
import { logRequestTimings, logTimingsForRequest } from "./log";

function setRequestId(id: string | null): void {
  vi.mocked(headers).mockResolvedValue(new Headers(id === null ? {} : { "x-request-id": id }));
}

describe("timing/store eviction", () => {
  beforeEach(() => {
    _resetForTests();
    vi.mocked(headers).mockReset();
  });

  it("getOrCreateStore caps the map at MAX_STORED_REQUESTS, evicting oldest-inserted", () => {
    for (let i = 0; i < MAX_STORED_REQUESTS; i += 1) {
      getOrCreateStore(`req-${i}`);
    }
    expect(stores.size).toBe(MAX_STORED_REQUESTS);
    expect(stores.has("req-0")).toBe(true);

    // One past the cap: the oldest key ("req-0") is evicted to make room.
    getOrCreateStore("req-overflow");
    expect(stores.size).toBe(MAX_STORED_REQUESTS);
    expect(stores.has("req-0")).toBe(false);
    expect(stores.has("req-1")).toBe(true);
    expect(stores.has("req-overflow")).toBe(true);
  });

  it("updating an existing store never evicts anything", () => {
    for (let i = 0; i < MAX_STORED_REQUESTS; i += 1) {
      getOrCreateStore(`req-${i}`);
    }
    stores.get("req-0")?.entries.push({ label: "cache", durMs: 1 });
    const store = getOrCreateStore("req-0");
    expect(store.entries).toHaveLength(1);
    expect(stores.size).toBe(MAX_STORED_REQUESTS);
  });

  it("deleteStore drops the request's store and is a no-op for unknown ids", () => {
    getOrCreateStore("req-del");
    expect(stores.has("req-del")).toBe(true);
    deleteStore("req-del");
    expect(stores.has("req-del")).toBe(false);
    expect(() => deleteStore("never-existed")).not.toThrow();
  });

  it("logTimingsForRequest deletes the store on the production early-return path", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.DEPTEND_TIMING_LOG;
    stores.set("req-prod", { entries: [{ label: "cache", durMs: 1 }] });
    logTimingsForRequest("/", 5, "req-prod");
    expect(stores.has("req-prod")).toBe(false);
    vi.unstubAllEnvs();
  });

  it("logRequestTimings resolves the id from the request scope and cleans up", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.DEPTEND_TIMING_LOG;
    setRequestId("req-scope");
    await logRequestTimings("/", 5);
    expect(stores.has("req-scope")).toBe(false);
    vi.unstubAllEnvs();
  });

  it("logTimingsForRequest is a no-op without a request id", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.DEPTEND_TIMING_LOG;
    stores.set("req-kept", { entries: [{ label: "cache", durMs: 1 }] });
    await logTimingsForRequest("/", 5, null);
    // Unrelated store must be untouched — the null-reqId early return
    // deletes nothing.
    expect(stores.has("req-kept")).toBe(true);
    vi.unstubAllEnvs();
  });

  it("logTimingsForRequest keeps the store until the deferred full pass in dev", () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "development");
    setRequestId("req-dev");
    stores.set("req-dev", { entries: [] });
    logTimingsForRequest("/missions", 5, "req-dev");
    // The synchronous pass ("page-done") must NOT have deleted the store —
    // the deferred read still needs it.
    expect(stores.has("req-dev")).toBe(true);
    vi.runAllTimers();
    expect(stores.has("req-dev")).toBe(false);
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("readEntries finds recorded entries in the store (eviction keeps read path intact)", () => {
    getOrCreateStore("req-read").entries.push({ label: "missions:board", durMs: 3.2 });
    expect(readEntries("req-read").map((e) => e.label)).toEqual(["missions:board"]);
  });
});
