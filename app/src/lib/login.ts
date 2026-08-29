/**
 * GitHub login validation at the auth boundary.
 *
 * Per H2 (security audit 2026-08-29): every mutating API route keys
 * rate limits and authorization on session.user.login. Without this guard
 * a non-conforming GitHub login would reach the DB and the rate-limit
 * Map; a forged / renamed-collision login would be accepted as a
 * valid user. Mirrors GitHub's own account-name spec
 * (https://github.com/join - "Username may only contain alphanumeric
 * characters or single hyphens, and cannot begin or end with a hyphen")
 * and the documented 39-character cap. Empty-string and non-string
 * inputs are explicitly rejected (a regex-only check would let an
 * empty string through).
 *
 * Fail-closed: returns false for any string that doesn't exactly match
 * the spec, including null, undefined, non-strings, and empty strings.
 * The auth.ts jwt() callback uses this to refuse to stamp a malformed
 * login onto a token, which forces next-auth to surface the user as
 * unauthenticated on the next request - cleaner than a downstream
 * "this user has no login" 401 from every mutating route.
 */
export const GITHUB_LOGIN_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

export function isValidLogin(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && GITHUB_LOGIN_PATTERN.test(value);
}
