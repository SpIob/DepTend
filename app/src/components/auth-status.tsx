"use client";

import { signIn, signOut, useSession } from "next-auth/react";

export function AuthStatus(): React.JSX.Element {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <span className="text-ink-muted font-mono text-xs">…</span>;
  }

  if (session?.user) {
    return (
      <div className="flex items-center gap-2 font-mono text-xs">
        <span className="text-ink-muted">{session.user.login ?? session.user.name}</span>
        <button
          type="button"
          onClick={() => void signOut()}
          className="text-accent hover:text-ink underline decoration-dotted underline-offset-2"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void signIn("github")}
      className="text-accent hover:text-ink font-mono text-xs underline decoration-dotted underline-offset-2"
    >
      Sign in with GitHub
    </button>
  );
}
