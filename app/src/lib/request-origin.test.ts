/**
 * isSameOrigin() unit tests — the CSRF defense-in-depth gate shared by all
 * eight mutating API routes (ADR 0037).
 *
 * The contract: a present Origin header must match Host/X-Forwarded-Host;
 * an absent Origin header is allowed (browsers attach Origin to every POST,
 * so absence means a non-browser client that CSRF can't victimize); anything
 * unparseable or missing a host to compare against fails closed.
 *
 * Note on construction: undici's Request does NOT synthesize a Host header
 * from the URL (the HTTP layer adds it at dispatch time in real traffic),
 * so every case here sets host/x-forwarded-host explicitly.
 */

import { describe, expect, it } from "vitest";
import { isSameOrigin } from "./request-origin";

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://deptend.vercel.app/api/repos", { method: "POST", headers });
}

describe("isSameOrigin", () => {
  it("allows a request with no Origin header (non-browser client)", () => {
    expect(isSameOrigin(requestWith({}))).toBe(true);
  });

  it("allows an Origin matching the plain Host header", () => {
    expect(
      isSameOrigin(
        requestWith({ origin: "https://deptend.vercel.app", host: "deptend.vercel.app" }),
      ),
    ).toBe(true);
  });

  it("prefers x-forwarded-host over Host when comparing", () => {
    expect(
      isSameOrigin(
        requestWith({
          origin: "https://deptend.vercel.app",
          host: "internal-origin.example",
          "x-forwarded-host": "deptend.vercel.app",
        }),
      ),
    ).toBe(true);
  });

  it("rejects an Origin that mismatches both Host and x-forwarded-host", () => {
    expect(
      isSameOrigin(requestWith({ origin: "https://evil.example", host: "deptend.vercel.app" })),
    ).toBe(false);
    expect(
      isSameOrigin(
        requestWith({
          origin: "https://evil.example",
          host: "internal-origin.example",
          "x-forwarded-host": "deptend.vercel.app",
        }),
      ),
    ).toBe(false);
  });

  it("compares hosts, not schemes — http Origin on an https host still matches", () => {
    // Vercel terminates TLS at the edge; internal hops are plain HTTP. A
    // scheme-sensitive comparison would reject legitimate same-site traffic.
    expect(
      isSameOrigin(
        requestWith({ origin: "http://deptend.vercel.app", host: "deptend.vercel.app" }),
      ),
    ).toBe(true);
  });

  it("treats port-bearing hosts as distinct from bare hosts", () => {
    expect(
      isSameOrigin(
        new Request("http://localhost:3000/api/repos", {
          method: "POST",
          headers: { origin: "http://localhost:3000", host: "localhost:3000" },
        }),
      ),
    ).toBe(true);
    expect(
      isSameOrigin(requestWith({ origin: "http://localhost:3000", host: "deptend.vercel.app" })),
    ).toBe(false);
  });

  it("fails closed on an unparseable Origin", () => {
    expect(isSameOrigin(requestWith({ origin: "not a url" }))).toBe(false);
  });

  it("fails closed when no host header exists to compare against", () => {
    // Origin present but neither Host nor x-forwarded-host set — cannot
    // happen from a real browser (which always sends Host), treated hostile.
    expect(isSameOrigin(requestWith({ origin: "https://deptend.vercel.app" }))).toBe(false);
  });
});
