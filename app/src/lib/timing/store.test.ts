/**
 * Tests for the simplified per-request timing store.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TimingEntry } from "./store";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

import { headers } from "next/headers";
import {
  withTiming,
  currentRequestId,
  readEntries,
  formatServerTimingEntries,
  _resetForTests,
  stores,
} from "./store";

function setRequestId(id: string | null): void {
  vi.mocked(headers).mockResolvedValue(new Headers(id === null ? {} : { "x-request-id": id }));
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
    setRequestId(null);
    expect(await currentRequestId()).toBeNull();
    await withTiming("ignored", async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
    expect(readEntries()).toEqual([]);
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
    // Manually record entries since we don't have recordTiming anymore
    stores.set("req-format", {
      entries: [
        { label: "cache", durMs: 3.4567 },
        { label: "db", durMs: 12.1234 },
        { label: "cache", durMs: 1.5 },
      ],
    });
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
    const outerEntry = entries.find((e) => e.label === "outer");
    const innerEntry = entries.find((e) => e.label === "inner");
    expect(outerEntry).toBeDefined();
    expect(innerEntry).toBeDefined();
    if (outerEntry === undefined || innerEntry === undefined) return;
    expect(outerEntry.durMs).toBeGreaterThanOrEqual(innerEntry.durMs);
  });
});
