/**
 * Origin-header validation for the mutating API routes.
 *
 * Defense-in-depth CSRF hardening layered on top of next-auth v4's session
 * cookie defaults (HttpOnly + Secure in production + SameSite=Lax). Lax
 * already stops cross-site POSTs from carrying the session cookie; this
 * check additionally rejects any cross-origin request that does arrive with
 * a cookie (e.g. a browser that downgrades SameSite behavior, or a future
 * cookie-config regression) so no route's correctness depends on a single
 * upstream default. ADR 0037.
 *
 * Semantics:
 *   - Origin present and matching Host/X-Forwarded-Host → allowed.
 *   - Origin present and mismatched → rejected (the classic cross-site case).
 *   - Origin absent → allowed. Browsers attach Origin to every POST they
 *     issue (fetch/XHR included), so an absent header means a non-browser
 *     client, which cannot be the victim of CSRF by definition. This keeps
 *     curl/CLI testing workable without weakening the actual defense.
 *
 * Only hosts are compared, never schemes: Vercel terminates TLS at the edge
 * and proxies internally over HTTP, so scheme equality would misfire while
 * host equality is exactly the property a cross-site attacker cannot fake
 * (they can trigger requests FROM the victim's browser but not rewrite its
 * Origin header).
 */

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) {
    return true;
  }

  // Vercel preserves the original site in x-forwarded-host; fall back to the
  // plain Host header for local dev and direct deployments.
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host === null) {
    // No host to compare against can't happen on a real server, but treat it
    // as hostile rather than letting a malformed environment bypass the check.
    return false;
  }

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
