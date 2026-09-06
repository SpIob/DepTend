import { NextResponse } from "next/server";

/**
 * Catch-all for any /api/* path that doesn't match a real route file.
 *
 * Without this, Next.js falls back to the top-level 404 HTML page for
 * unmatched API routes — same content, same status surface — which is
 * wrong in two ways:
 *
 * 1. The response status is HTTP 200 (the App Router serves the 404 page
 *    with status 200 unless a route explicitly sets one — the
 *    page-level `notFound()` machinery doesn't apply to /api/*).
 * 2. The response body is HTML, not JSON. Any client doing
 *    `await res.json()` throws, and a `Response.ok` check would falsely
 *    pass (200 is in 2xx) before the throw, masking the error.
 *
 * Both shape a silent failure for any caller that hits a mistyped API
 * path (typo in the route, removed endpoint, scraper probing). The fix
 * is the API-side analog of ADR 0048's `app/src/app/[...slug]/page.tsx`
 * catch-all: one file, one explicit 404 with a JSON body and the right
 * status code. Same idiom, different tree — `/api/` doesn't share
 * `/app/`'s routing layout.
 */
function notFoundJson(): NextResponse {
  return NextResponse.json(
    { error: "Not found." },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

export function GET(): NextResponse {
  return notFoundJson();
}

export function POST(): NextResponse {
  return notFoundJson();
}

export function PUT(): NextResponse {
  return notFoundJson();
}

export function PATCH(): NextResponse {
  return notFoundJson();
}

export function DELETE(): NextResponse {
  return notFoundJson();
}

export function HEAD(): NextResponse {
  // 404 must not carry a body, but the JSON-envelope shape doesn't apply
  // to HEAD — an empty 404 response is the convention (mirrors the
  // 405-on-wrong-method responses the real routes already return).
  return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}
