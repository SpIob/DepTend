"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import type { IngestionStatus } from "@deptend/core/db/schema.js";
import { extractErrorMessage } from "@/lib/fetch-error";

type WithdrawRequestState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "pending" }
  | { kind: "done" }
  | { kind: "error"; message: string };

// Kept in sync with the server-side guard in db/repos.ts's withdrawOwnRepo()
// — not the source of truth, just avoids showing a button that would 409.
const WITHDRAWABLE_STATUSES: readonly IngestionStatus[] = ["pending", "skipped"];

/**
 * Self-service reclaim (Roadmap "Now #4", Option B) — lets the original
 * submitter remove their own repo while it's still unindexed, freeing the
 * cap slot without needing Mico to do it by hand via direct SQL. Same
 * self-contained fetch + request-state shape as BookmarkToggle/MissionActions,
 * plus an explicit two-step confirm since this one is destructive and,
 * unlike a bookmark, not reversible from the UI.
 *
 * Renders null unless the signed-in viewer is literally the submitter AND
 * the repo is still in a withdrawable status — so this simply doesn't
 * appear for anyone it doesn't apply to, rather than appearing and then
 * failing.
 */
export function WithdrawButton({
  repoId,
  submittedBy,
  ingestionStatus,
}: {
  repoId: string;
  submittedBy: string | null;
  ingestionStatus: IngestionStatus;
}): React.JSX.Element | null {
  const { data: session } = useSession();
  const [request, setRequest] = useState<WithdrawRequestState>({ kind: "idle" });
  const login = session?.user?.login;

  if (
    login === undefined ||
    submittedBy === null ||
    login !== submittedBy ||
    !WITHDRAWABLE_STATUSES.includes(ingestionStatus)
  ) {
    return null;
  }

  async function withdraw(): Promise<void> {
    setRequest({ kind: "pending" });
    try {
      const response = await fetch(`/api/repos/${repoId}/withdraw`, { method: "POST" });
      const data: unknown = await response.json();
      if (!response.ok) {
        setRequest({
          kind: "error",
          message: extractErrorMessage(data) ?? "Something went wrong.",
        });
        return;
      }
      setRequest({ kind: "done" });
    } catch {
      setRequest({ kind: "error", message: "Network error — try again." });
    }
  }

  if (request.kind === "done") {
    return (
      <p className="text-ink-muted font-mono text-xs">
        Submission withdrawn — it no longer counts against the repo cap.
      </p>
    );
  }

  const pending = request.kind === "pending";
  const confirming = request.kind === "confirming";
  const errorMessage = request.kind === "error" ? request.message : null;

  return (
    <div className="flex flex-col items-start gap-1">
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-ink-muted font-mono text-xs">Remove this submission?</span>
          <button
            type="button"
            disabled={pending}
            onClick={() => void withdraw()}
            className="text-status-error font-mono text-xs underline decoration-dotted underline-offset-2 disabled:opacity-50"
          >
            {pending ? "Removing…" : "Yes, remove it"}
          </button>
          <button
            type="button"
            onClick={() => {
              setRequest({ kind: "idle" });
            }}
            className="text-ink-muted hover:text-ink font-mono text-xs underline decoration-dotted underline-offset-2"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setRequest({ kind: "confirming" });
          }}
          className="text-ink-muted hover:text-ink font-mono text-xs underline decoration-dotted underline-offset-2"
        >
          You submitted this — remove it?
        </button>
      )}
      <div role="status" aria-live="polite">
        {errorMessage !== null && (
          <p className="text-status-error text-[10px] leading-tight">{errorMessage}</p>
        )}
      </div>
    </div>
  );
}
