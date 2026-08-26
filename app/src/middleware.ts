/**
 * Per-request nonce + Content-Security-Policy middleware (ADR 0037).
 *
 * STAGED ROLLOUT — currently REPORT-ONLY. The policy below is the real,
 * enforced-shaped policy (nonce-based script-src, no 'unsafe-inline'), but
 * it is emitted as `Content-Security-Policy-Report-Only` so violations show
 * up in the browser console without breaking anything. To flip to enforced:
 * change CSP_ENFORCED to true. That is the entire rollout step.
 *
 * How the nonce reaches Next's scripts: setting a `Content-Security-Policy`
 * header on the REQUEST headers passed to NextResponse.next() makes the
 * App Router parse the policy, extract the nonce, and stamp every inline
 * bootstrap/hydration script it renders with it. The response header is
 * what browsers actually enforce or report on. Both carry the same policy
 * string, so the report-only → enforced flip changes nothing about how the
 * page is built — only whether the browser blocks on it.
 *
 * Why middleware at all: an enforced CSP for App Router requires noncing
 * Next's own inline scripts, and the only injection point for that is
 * middleware. All three pages are already `force-dynamic`, so middleware's
 * dynamic-rendering side effect costs this app nothing (ADR 0037).
 *
 * Deliberately NOT in this stage: a report-uri/report-to endpoint (no free,
 * account-less reporting service fits the zero-budget constraint — browser
 * console is the violation surface until that changes), and tightening
 * style-src beyond 'unsafe-inline' (Tailwind ships as compiled CSS files,
 * but attribute-level styles are unverified against production; revisit
 * after the enforced flip has soaked).
 */

import { NextResponse, type NextRequest } from "next/server";

/**
 * The single rollout switch. Report-Only now; flip to true after the
 * deployed site has run this exact policy in report mode clean of script/
 * style violations (the ADR 0037 acceptance check).
 *
 * The `as boolean` assertion is load-bearing: a bare `false` literal gives
 * the constant a literal type, no-unnecessary-condition reads the
 * header-name ternary below as statically falsy and fails the build, and
 * the `: boolean` annotation that would widen it is itself rejected by
 * no-inferrable-types. The assertion widens without tripping either rule,
 * so the flip stays a genuine conditional.
 */
const CSP_ENFORCED = false as boolean;

function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV !== "production";
  // Dev needs 'unsafe-eval' (react-refresh) and 'unsafe-inline' (dev
  // overlays); neither leaks into the production policy.
  const scriptSrc = isDev
    ? `'self' 'nonce-${nonce}' 'unsafe-eval' 'unsafe-inline'`
    : `'self' 'nonce-${nonce}'`;

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://github.com https://*.githubusercontent.com",
    "connect-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce);

  // Request-side header: how the App Router learns the nonce. (It reads the
  // policy from here regardless of what the response eventually says.)
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  // Response-side header: what the browser acts on.
  response.headers.set(
    CSP_ENFORCED ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only",
    csp,
  );
  return response;
}

export const config = {
  // Everything except immutable static assets — those never need a nonce
  // and short-circuiting them keeps middleware overhead off the hot path.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
