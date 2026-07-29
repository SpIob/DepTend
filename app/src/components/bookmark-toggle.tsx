"use client";

import { useState } from "react";
import { signIn, useSession } from "next-auth/react";

type BookmarkRequestState =
  { kind: "idle" } | { kind: "pending" } | { kind: "error"; message: string };

function extractErrorMessage(data: unknown): string | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  return typeof record.error === "string" ? record.error : null;
}

/**
 * Save/unsave a repo for quicker access (ADR 0027) — same self-contained
 * fetch + request-state shape as ClaimAction (mission-card.tsx). Local
 * optimistic-ish state (set only after a confirmed 2xx, same as
 * ClaimAction) rather than a callback into a parent list, since — unlike
 * a mission's claim status — nothing else on the page needs to react to
 * one card's bookmark state changing.
 */
export function BookmarkToggle({
  repoId,
  initialBookmarked,
}: {
  repoId: string;
  initialBookmarked: boolean;
}): React.JSX.Element {
  const { data: session } = useSession();
  const [bookmarked, setBookmarked] = useState(initialBookmarked);
  const [request, setRequest] = useState<BookmarkRequestState>({ kind: "idle" });
  const login = session?.user?.login;

  async function toggle(): Promise<void> {
    const action = bookmarked ? "unbookmark" : "bookmark";
    setRequest({ kind: "pending" });
    try {
      const response = await fetch(`/api/repos/${repoId}/${action}`, { method: "POST" });
      const data: unknown = await response.json();
      if (!response.ok) {
        setRequest({
          kind: "error",
          message: extractErrorMessage(data) ?? "Something went wrong.",
        });
        return;
      }
      setRequest({ kind: "idle" });
      setBookmarked((prev) => !prev);
    } catch {
      setRequest({ kind: "error", message: "Network error — try again." });
    }
  }

  if (login === undefined) {
    return (
      <button
        type="button"
        onClick={() => void signIn("github")}
        title="Sign in with GitHub to bookmark this repo"
        aria-label="Sign in with GitHub to bookmark this repo"
        className="text-ink-muted hover:text-ink shrink-0 font-mono text-base leading-none"
      >
        ☆
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
        aria-pressed={bookmarked}
        aria-label={bookmarked ? "Remove bookmark" : "Bookmark this repo"}
        title={bookmarked ? "Remove bookmark" : "Bookmark this repo"}
        className={`font-mono text-base leading-none transition-colors disabled:opacity-50 ${
          bookmarked ? "text-accent" : "text-ink-muted hover:text-ink"
        }`}
      >
        {bookmarked ? "★" : "☆"}
      </button>
      {errorMessage !== null && (
        <p className="text-severity-critical text-[10px] leading-tight">{errorMessage}</p>
      )}
    </div>
  );
}
