"use client";

import { useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";

export function AuthStatus(): React.JSX.Element {
  const { data: session, status } = useSession();
  const [busy, setBusy] = useState(false);

  if (status === "loading") {
    return <span className="text-ink-muted font-mono text-xs">…</span>;
  }

  if (session?.user) {
    return (
      <div className="flex items-center gap-2 font-mono text-xs">
        <span className="text-ink-muted">{session.user.login ?? session.user.name}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void signOut();
          }}
          className="text-accent hover:text-ink underline decoration-dotted underline-offset-2 disabled:opacity-50"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void signIn("github");
      }}
      className="text-accent hover:text-ink font-mono text-xs underline decoration-dotted underline-offset-2 disabled:opacity-50"
    >
      Sign in with GitHub
    </button>
  );
}
