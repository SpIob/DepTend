"use client";

import { useState } from "react";
import { signIn, useSession } from "next-auth/react";

type NotificationRequestState =
  { kind: "idle" } | { kind: "pending" } | { kind: "error"; message: string };

function extractErrorMessage(data: unknown): string | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  return typeof record.error === "string" ? record.error : null;
}

/**
 * Subscribe/unsubscribe to GitHub Issues notifications for a repo.
 */
export function NotificationToggle({
  repoId,
  initialSubscribed,
}: {
  repoId: string;
  initialSubscribed: boolean;
}): React.JSX.Element {
  const { data: session } = useSession();
  const login = session?.user?.login;
  const [subscribed, setSubscribed] = useState(initialSubscribed);
  const [request, setRequest] = useState<NotificationRequestState>({ kind: "idle" });

  async function toggle(): Promise<void> {
    const action = subscribed ? "unsubscribe" : "subscribe";
    setRequest({ kind: "pending" });
    try {
      const response = await fetch(`/api/repos/${repoId}/notifications/${action}`, {
        method: "POST",
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        setRequest({
          kind: "error",
          message: extractErrorMessage(data) ?? "Something went wrong.",
        });
        return;
      }
      setRequest({ kind: "idle" });
      setSubscribed((prev) => !prev);
    } catch {
      setRequest({ kind: "error", message: "Network error — try again." });
    }
  }

  if (login === undefined) {
    return (
      <button
        type="button"
        onClick={() => void signIn("github")}
        title="Sign in with GitHub to subscribe to notifications"
        aria-label="Sign in with GitHub to subscribe to notifications"
        className="text-ink-muted hover:text-ink shrink-0 p-0.5 font-mono text-xs leading-none"
      >
        Notify
      </button>
    );
  }

  const pending = request.kind === "pending";
  const errorMessage = request.kind === "error" ? request.message : null;

  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5">
      <button
        type="button"
        disabled={pending}
        onClick={() => void toggle()}
        aria-pressed={subscribed}
        title={subscribed ? "Unsubscribe from notifications" : "Subscribe to notifications"}
        className={`rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors disabled:opacity-50 ${
          subscribed
            ? "border-accent bg-accent/10 text-accent"
            : "border-border text-ink-muted hover:text-ink hover:border-ink-muted"
        }`}
      >
        {pending ? "..." : subscribed ? "Notify ✓" : "Notify"}
      </button>
      <div role="status" aria-live="polite">
        {errorMessage !== null && (
          <p className="text-status-error text-[10px] leading-tight">{errorMessage}</p>
        )}
      </div>
    </div>
  );
}
