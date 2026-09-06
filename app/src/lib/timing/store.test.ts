/**
 * Tests for the per-request timing store. The store is the foundation
 * for ADR 0052's per-segment Server-Timing follow-up; if these tests
 * drift, the production helper will silently misbehave.
 *
 * The store is built on a module-level Map<requestId, TimingStore>,
 * keyed by the request id set by the middleware and read via
 * `next/headers` in production. In tests we stub `next/headers` to
 * return a fixed id.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TimingEntry } from "./store";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

import { headers } from "next/headers";
import {
  withTiming,
  withTimingSync,
  currentRequestId,
  readEntries,
  formatServerTimingEntries,
  recordTiming,
  _resetForTests,
  _setCurrentRequestIdForTests,
} from "./store";

function setRequestId(id: string | null): void {
  vi.mocked(headers).mockResolvedValue(new Headers(id === null ? {} : { "x-request-id": id }));
  _setCurrentRequestIdForTests(id);
}

describe("timing/store", () => {
  beforeEach(() => {
    _resetForTests();
    vi.mocked(headers).mockReset();
  });

  it("records timings inside the request scope", async () => {
    setRequestId("req-1");
    await withTiming("cache", async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    await withTiming("db", async () => {
      await new Promise((r) => setTimeout(r, 2));
    });
    const entries = readEntries("req-1");
    expect(entries.map((e) => e.label)).toEqual(["cache", "db"]);
    expect(entries.find((e) => e.label === "cache")?.durMs).toBeGreaterThanOrEqual(4);
    expect(entries.find((e) => e.label === "db")?.durMs).toBeGreaterThanOrEqual(1);
  });

  it("isolates timing data across concurrent requests", async () => {
    const [a, b] = await Promise.all([
      (async (): Promise<TimingEntry[]> => {
        setRequestId("req-A");
        await withTiming("db", async () => {
          await new Promise((r) => setTimeout(r, 5));
        });
        return readEntries("req-A");
      })(),
      (async (): Promise<TimingEntry[]> => {
        setRequestId("req-B");
        await withTiming("cache", async () => {
          await new Promise((r) => setTimeout(r, 2));
        });
        return readEntries("req-B");
      })(),
    ]);
    expect(a.map((e) => e.label)).toEqual(["db"]);
    expect(b.map((e) => e.label)).toEqual(["cache"]);
  });

  it("returns no entries outside a request scope (no recording)", async () => {
    // No request id set — async withTiming should still work, just not record.
    setRequestId(null);
    expect(await currentRequestId()).toBeNull();
    await withTiming("ignored", async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
    expect(readEntries()).toEqual([]);
  });

  it("withTimingSync records synchronous work and respects the request scope", () => {
    setRequestId("req-sync");
    withTimingSync("sync-op", () => {
      // Burn ~1ms via setTimeout-equivalent busy-wait.
      const start = process.hrtime.bigint();
      while (Number(process.hrtime.bigint() - start) / 1e6 < 2) {
        // no-op busy wait — long enough to cross the 1ms threshold on any CI box
      }
    });
    const entries = readEntries("req-sync");
    expect(entries.length).toBe(1);
    expect(entries[0]?.label).toBe("sync-op");
    expect(entries[0]?.durMs).toBeGreaterThanOrEqual(1);
  });

  it("withTiming records the timing even when fn throws", async () => {
    setRequestId("req-throw");
    await expect(
      withTiming("error-prone", async () => {
        await new Promise((r) => setTimeout(r, 2));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const entries = readEntries("req-throw");
    expect(entries.length).toBe(1);
    expect(entries[0]?.label).toBe("error-prone");
  });

  it("formatServerTimingEntries sums same-label entries and rounds to 1 dp", () => {
    setRequestId("req-format");
    recordTiming("cache", 3.4567);
    recordTiming("db", 12.1234);
    recordTiming("cache", 1.5);
    const entries = readEntries("req-format");
    const formatted = formatServerTimingEntries(entries);
    expect(formatted).toBe("cache;dur=5.0, db;dur=12.1");
  });

  it("formatServerTimingEntries returns null on empty input", () => {
    expect(formatServerTimingEntries([])).toBeNull();
  });

  it("nested withTiming calls record both, not just the outer", async () => {
    setRequestId("req-nested");
    await withTiming("outer", async () => {
      await new Promise((r) => setTimeout(r, 1));
      await withTiming("inner", async () => {
        await new Promise((r) => setTimeout(r, 1));
      });
    });
    const entries = readEntries("req-nested");
    expect(entries.map((e) => e.label).sort()).toEqual(["inner", "outer"]);
    // inner < outer (outer includes inner + a bit more)
    const outerEntry = entries.find((e) => e.label === "outer");
    const innerEntry = entries.find((e) => e.label === "inner");
    expect(outerEntry).toBeDefined();
    expect(innerEntry).toBeDefined();
    if (outerEntry === undefined || innerEntry === undefined) return;
    expect(outerEntry.durMs).toBeGreaterThanOrEqual(innerEntry.durMs);
  });
});
