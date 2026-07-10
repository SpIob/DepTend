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
 */

import type { NextAuthOptions } from "next-auth";
import GithubProvider, { type GithubProfile } from "next-auth/providers/github";

export const authOptions: NextAuthOptions = {
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
        token.login = (user as { login?: string }).login;
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
