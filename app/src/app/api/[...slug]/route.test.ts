/**
 * Route-level tests for the /api/* catch-all at app/src/app/api/[...slug]/route.ts.
 *
 * Without this file, an unmatched API path (e.g. POST /api/repos/precheck)
 * falls through to the top-level 404 HTML page and is served with
 * status 200 + content-type text/html. Any caller doing
 * `await res.json()` throws, and a `Response.ok` check would falsely
 * pass (200 is in 2xx) before the throw. This catch-all fixes that by
 * returning a real 404 with a JSON envelope — the API-side analog of
 * app/src/app/[...slug]/page.tsx (ADR 0048) for /app/* routes.
 *
 * Every method the real /api/* routes use (GET/POST/PUT/PATCH/DELETE)
 * is asserted here, plus HEAD/OPTIONS for completeness (both must
 * return 404 with no body — an empty 404 response is the convention
 * for HEAD, and OPTIONS doesn't carry a body either).
 */

import { describe, expect, it } from "vitest";
import { DELETE, GET, OPTIONS, PATCH, POST, PUT, HEAD } from "./route";

describe("/api/[...slug] catch-all", () => {
  it("returns 404 with a JSON envelope for GET on an unmatched path", async () => {
    const response = GET();
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = (await response.json()) as { error?: string };
    expect(data.error).toBe("Not found.");
  });

  it("returns 404 with a JSON envelope for POST on an unmatched path", async () => {
    const response = POST();
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    const data = (await response.json()) as { error?: string };
    expect(data.error).toBe("Not found.");
  });

  it("returns 404 for PUT", () => {
    const response = PUT();
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("returns 404 for PATCH", () => {
    const response = PATCH();
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("returns 404 for DELETE", () => {
    const response = DELETE();
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("returns 404 with no body for HEAD (body-less method)", async () => {
    const response = HEAD();
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toBe("");
  });

  it("returns 404 with no body for OPTIONS", async () => {
    const response = OPTIONS();
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toBe("");
  });
});
