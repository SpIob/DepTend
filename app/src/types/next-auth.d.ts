import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    /** GitHub username, captured in the GithubProvider profile() callback. */
    login?: string | undefined;
  }

  interface Session {
    user?: DefaultSession["user"] & {
      /** GitHub username — used to stamp repos.submitted_by on repo submission. */
      login?: string | undefined;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    login?: string | undefined;
  }
}
