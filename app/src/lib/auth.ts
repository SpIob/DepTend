/**
 * next-auth configuration
 *
 * JWT sessions, not database sessions — no sessions/accounts/users tables
 * exist in schema.ts, and none are needed. Repo submission (next up in
 * Phase 3) only needs to know the submitter's GitHub login to stamp
 * repos.submitted_by; nothing else about the user is persisted anywhere.
 * See ADR 0011-era Phase 3 kickoff discussion — JWT was the agreed choice
 * specifically to avoid a schema migration for auth.
 *
 * Reads env vars directly rather than through an eager-throwing helper —
 * this module gets evaluated during `next build`'s route collection even
 * though the route itself is dynamic, so it must not throw at import time
 * if GH_CLIENT_ID/GH_CLIENT_SECRET aren't set in the build environment
 * (same class of bug as the DB client — see app/src/lib/db.ts).
 *
 * H2 (security audit 2026-08-29): the jwt() callback validates
 * user.login against GitHub's account-name spec before stamping it
 * onto the token. A non-conforming login (a forged/renamed-collision
 * identifier, a null, a string with whitespace or special chars)
 * leaves the session with login: undefined, so every downstream
 * consumer (the rate-limit Map, repos.submitted_by, missions.claimed_by,
 * repo_bookmarks.user_login, notification_subscriptions.user_login)
 * naturally returns 401 instead of accepting a malformed identifier.
 *
 * H3 (security audit 2026-08-29): NEXTAUTH_SECRET is passed explicitly.
 * A deploy missing the env var fails loudly at request time, not at
 * JWT-decode time, and CI / test environments can set a known dev
 * value. next-auth v4 would otherwise fall back to
 * process.env.NEXTAUTH_SECRET on its own, but only in Node contexts;
 * making it explicit removes that implicit contract.
 */

import type { NextAuthOptions } from "next-auth";
import GithubProvider, { type GithubProfile } from "next-auth/providers/github";
import { isValidLogin } from "./login";

export const authOptions: NextAuthOptions = {
  // H3: pass NEXTAUTH_SECRET explicitly. A deploy missing the env var
  // fails loudly at request time, not at JWT-decode time, and CI / test
  // environments can set a known dev value. next-auth v4 would otherwise
  // fall back to process.env.NEXTAUTH_SECRET on its own, but only in
  // Node contexts; making it explicit removes that implicit contract.
  //
  // exactOptionalPropertyTypes treats the unset case differently from
  // an explicit undefined, so the conditional spread keeps the field
  // absent when the env var isn't set rather than passing a typed
  // `undefined` (which would fail the type checker). next-auth's
  // runtime falls back to the env var internally in that case.
  ...(process.env.NEXTAUTH_SECRET !== undefined && process.env.NEXTAUTH_SECRET !== ""
    ? { secret: process.env.NEXTAUTH_SECRET }
    : {}),
  session: { strategy: "jwt" },
  providers: [
    GithubProvider({
      clientId: process.env.GH_CLIENT_ID ?? "",
      clientSecret: process.env.GH_CLIENT_SECRET ?? "",
      profile(profile: GithubProfile) {
        return {
          id: profile.id.toString(),
          name: profile.name ?? profile.login,
          email: profile.email,
          image: profile.avatar_url,
          // Stamped raw; the jwt() callback validates via
          // isValidLogin() before allowing it onto the token.
          login: profile.login,
        };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      // next-auth's own JSDoc on this callback says `user` is only present
      // when trigger is "signIn"/"signUp" — every other call it's absent —
      // but the declared type is `User | AdapterUser` with no `undefined`,
      // so this guard reads as "always truthy" to the type checker even
      // though it's genuinely required at runtime.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (user) {
        const rawLogin = (user as { login?: unknown }).login;
        token.login = isValidLogin(rawLogin) ? rawLogin : undefined;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.login = typeof token.login === "string" ? token.login : undefined;
      }
      return session;
    },
  },
};
