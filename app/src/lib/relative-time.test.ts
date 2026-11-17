import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "./relative-time";

describe("formatRelativeTime", () => {
  const now = Date.now();

  it("returns 'just now' for < 60 seconds", () => {
    const date = new Date(now - 30_000);
    expect(formatRelativeTime(date)).toBe("just now");
  });

  it("returns minutes for < 60 minutes", () => {
    const date = new Date(now - 5 * 60_000);
    expect(formatRelativeTime(date)).toBe("5m ago");
  });

  it("returns hours for < 24 hours", () => {
    const date = new Date(now - 3 * 60 * 60_000);
    expect(formatRelativeTime(date)).toBe("3h ago");
  });

  it("returns days for < 7 days", () => {
    const date = new Date(now - 2 * 24 * 60 * 60_000);
    expect(formatRelativeTime(date)).toBe("2d ago");
  });

  it("returns weeks for < 4 weeks", () => {
    const date = new Date(now - 2 * 7 * 24 * 60 * 60_000);
    expect(formatRelativeTime(date)).toBe("2w ago");
  });

  it("returns months for < 12 months", () => {
    const date = new Date(now - 3 * 30 * 24 * 60 * 60_000);
    expect(formatRelativeTime(date)).toBe("3mo ago");
  });

  it("returns years for >= 12 months", () => {
    const date = new Date(now - 2 * 365 * 24 * 60 * 60_000);
    expect(formatRelativeTime(date)).toBe("2y ago");
  });

  it("handles boundary at exactly 60 seconds", () => {
    const date = new Date(now - 60_000);
    expect(formatRelativeTime(date)).toBe("1m ago");
  });

  it("handles boundary at exactly 60 minutes", () => {
    const date = new Date(now - 60 * 60_000);
    expect(formatRelativeTime(date)).toBe("1h ago");
  });

  it("handles boundary at exactly 24 hours", () => {
    const date = new Date(now - 24 * 60 * 60_000);
    expect(formatRelativeTime(date)).toBe("1d ago");
  });
});
