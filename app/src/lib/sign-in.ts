import { signIn } from "next-auth/react";

/**
 * M2 (security audit 2026-08-29): pin the OAuth callback to the current
 * page's origin + path so a `?callbackUrl=...` tacked on by some
 * upstream caller can't redirect a freshly-signed-in user off the
 * legitimate domain. Wraps next-auth's signIn() so a future auth-library
 * swap is a single search-and-replace target.
 *
 * The pin uses `window.location.origin + window.location.pathname`
 * (not the full href) so the user's in-page filter state doesn't
 * ride along into the OAuth round-trip URL either - the sign-in
 * flow returns them to a clean version of the page they were on.
 *
 * next-auth's signIn() returns a SignInResponse | undefined; we
 * discard the value (callers don't await its shape) and resolve to
 * void so the helper's signature matches every existing call site's
 * `void signInWithGitHub()` expectation.
 */
export async function signInWithGitHub(): Promise<void> {
  await signIn("github", {
    callbackUrl: window.location.origin + window.location.pathname,
  });
}
