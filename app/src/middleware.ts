/**
 * Per-request nonce + Content-Security-Policy middleware (ADR 0037).
 *
 * ENFORCED since 2026-08-26. The policy is nonce-based (`script-src 'self'
 * 'nonce-…'`, no 'unsafe-inline' in production); browsers block inline
 * scripts that don't carry the request's nonce. It shipped report-only
 * first, per the staged rollout: `/` and `/missions` verified on the
 * deployed site with every inline script nonce-stamped (17/17 and 16/16),
 * zero console errors, zero violation reports — then CSP_ENFORCED flipped.
 * To roll back: set CSP_ENFORCED to false.
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
 *
 * H1 (security audit 2026-08-29): in addition to the CSP, the middleware
 * sets `Referrer-Policy: no-referrer` and a `Permissions-Policy` denying
 * the browser features this app never uses (camera, microphone,
 * geolocation, interest-cohort/FLoC, payment, USB). Vercel Hobby emits
 * `Strict-Transport-Security` at the platform layer; that is verified,
 * not set here, in the same change.
 *
 * S1 (perf observability, ADR 0052): the middleware additionally sets a
 * `Server-Timing` header on every non-asset response with one segment,
 * `total`, whose `dur` is the wall-clock time from middleware entry to
 * response build. This is genuinely always-on (set here, in the only
 * place that can set a response header in Next 15 App Router middleware).
 * The 60 s `unstable_cache` cache-hit / cache-miss gap, the 5-table
 * join duration, and the render time are NOT split into separate
 * segments in this iteration — that would require per-segment timing
 * hooks in the read paths, and the read paths cannot write response
 * headers from inside App Router page renders. The total-time signal
 * is the honest, low-risk first step; per-segment is the explicit
 * follow-up flagged in the ADR.
 */

import { NextResponse, type NextRequest } from "next/server";

/**
 * The single rollout switch. Flipped to true on 2026-08-26 after the
 * deployed report-only soak came back clean (see header note). Setting it
 * back to false returns the site to report-only without any other change.
 *
 * The `as boolean` assertion is load-bearing: a bare `false` literal gives
 * the constant a literal type, no-unnecessary-condition reads the
 * header-name ternary below as statically falsy and fails the build, and
 * the `: boolean` annotation that would widen it is itself rejected by
 * no-inferrable-types. The assertion widens without tripping either rule,
 * so the flip stays a genuine conditional.
 */
const CSP_ENFORCED = true as boolean;

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
  // S1 (ADR 0052): start the request-duration clock before any other work
  // so the recorded `total` segment covers nonce generation, CSP build, and
  // the synchronous NextResponse.next() setup. The page render that
  // happens after this function returns is NOT inside this duration; the
  // header is honestly named `total` for the middleware phase, not for the
  // full request. Per-segment split (cache vs DB vs render) is a follow-up.
  const startedAt = performance.now();
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

  // H1 (security audit 2026-08-29): additional security headers.
  // Referrer-Policy: no-referrer — every outbound link (e.g. "View on
  // GitHub") would otherwise leak the full URL state, including any
  // per-user filter state from /missions?q=...&severity=...&..., to
  // the third-party host. This is the conservative default; not even
  // the cross-origin path is shared.
  // Permissions-Policy: explicit deny list for browser features the
  // page never uses. If a future XSS-via-CSP-bypass lands, the
  // attacker has fewer browser capabilities (camera, microphone,
  // geolocation, FLoC, payment, USB) to weaponize as a result. Tighten
  // further when an actual need to use a feature is identified.
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set(
    "Permissions-Policy",
    [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "interest-cohort=()",
      "payment=()",
      "usb=()",
    ].join(", "),
  );

  // S1 (ADR 0052): emit the middleware-phase wall-clock as a Server-Timing
  // segment. Rounded to 1 decimal of milliseconds to keep the header
  // short; sub-ms resolution is noise on a network-attached measurement.
  // `description` is omitted (the standard says it's optional); clients
  // that care about it can pull a separate metric from their own probe.
  const elapsedMs = performance.now() - startedAt;
  response.headers.set("Server-Timing", `total;dur=${elapsedMs.toFixed(1)}`);

  return response;
}

export const config = {
  // Everything except immutable static assets — those never need a nonce
  // and short-circuiting them keeps middleware overhead off the hot path.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
