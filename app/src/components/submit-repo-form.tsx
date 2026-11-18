"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { signInWithGitHub } from "@/lib/sign-in";
import { extractErrorMessage } from "@/lib/fetch-error";
import {
  SUBMITTER_OPTIN_EVENT_TYPES,
  decideNotificationAction,
  buildSubmitSuccessMessage,
} from "./submit-repo-helpers";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

/** Pulls the success-path `message` string and the repo id. The route's success body is
 *  `{ message, repo }` (see app/src/app/api/repos/route.ts); the error
 *  body is `{ error }` and goes through extractErrorMessage instead. */
function parseSubmitSuccess(data: unknown): { message: string; repoId: string } | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : null;
  const repo = record.repo as Record<string, unknown> | null;
  const repoId = repo && typeof repo.id === "string" ? repo.id : null;
  if (message === null || repoId === null) {
    return null;
  }
  return { message, repoId };
}

export function SubmitRepoForm({
  repoCount,
  maxRepos,
}: {
  repoCount: number;
  maxRepos: number;
}): React.JSX.Element {
  const { data: session } = useSession();
  const [url, setUrl] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });
  const [notifyOptIn, setNotifyOptIn] = useState(false);

  const atCap = repoCount >= maxRepos;

  async function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setState({ kind: "submitting" });

    try {
      const response = await fetch("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubUrl: url }),
      });
      const data: unknown = await response.json();

      if (response.ok) {
        const parsed = parseSubmitSuccess(data);
        const baseMessage = parsed?.message ?? "Submitted.";
        const repoId = parsed?.repoId;

        const action = decideNotificationAction(notifyOptIn);

        if (action === "subscribe" && repoId) {
          // Fire-and-forget subscription attempt — never makes submission report as failed
          try {
            const subscribeResponse = await fetch(`/api/repos/${repoId}/notifications/subscribe`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ eventTypes: SUBMITTER_OPTIN_EVENT_TYPES }),
            });
            const _subscribeData: unknown = await subscribeResponse.json();

            let subscribeResult: "success" | "failed" | "unauthorized";
            if (subscribeResponse.ok) {
              subscribeResult = "success";
            } else if (subscribeResponse.status === 401) {
              subscribeResult = "unauthorized";
            } else {
              subscribeResult = "failed";
            }

            const composedMessage = buildSubmitSuccessMessage(baseMessage, true, subscribeResult);
            setState({ kind: "success", message: composedMessage });
          } catch {
            // Network error during subscribe — still report submission success
            const composedMessage = buildSubmitSuccessMessage(baseMessage, true, "failed");
            setState({ kind: "success", message: composedMessage });
          }
        } else {
          // No opt-in, or no repoId (shouldn't happen but guard anyway)
          const composedMessage = buildSubmitSuccessMessage(baseMessage, false, "success");
          setState({ kind: "success", message: composedMessage });
        }

        setUrl("");
        setNotifyOptIn(false);
      } else {
        setState({
          kind: "error",
          message: extractErrorMessage(data) ?? "Something went wrong.",
        });
      }
    } catch {
      setState({ kind: "error", message: "Network error — try again." });
    }
  }

  if (session?.user === undefined) {
    return (
      <p className="text-ink-muted text-sm">
        <button
          type="button"
          onClick={() => void signInWithGitHub()}
          className="text-accent hover:text-ink underline decoration-dotted underline-offset-2"
        >
          Sign in with GitHub
        </button>{" "}
        to submit a repo.
      </p>
    );
  }

  if (atCap) {
    return (
      <p className="text-ink-muted font-mono text-xs">
        {repoCount}/{maxRepos} repos indexed — cap reached for MVP.
      </p>
    );
  }

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className="flex flex-col gap-2 sm:flex-row sm:items-start"
    >
      <div className="flex flex-1 flex-col gap-1">
        <label htmlFor="repo-url" className="sr-only">
          GitHub repository URL
        </label>
        <input
          id="repo-url"
          type="text"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
          }}
          placeholder="https://github.com/owner/repo"
          required
          className="border-border bg-surface text-ink placeholder:text-ink-muted focus-visible:outline-accent w-full rounded-xs border px-3 py-1.5 font-mono text-sm"
        />
        <div role="status" aria-live="polite">
          {state.kind === "success" && (
            <p className="text-status-success text-xs">{state.message}</p>
          )}
          {state.kind === "error" && <p className="text-status-error text-xs">{state.message}</p>}
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:w-64 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={notifyOptIn}
            onChange={(e) => setNotifyOptIn(e.target.checked)}
            disabled={state.kind === "submitting"}
            className="border-border text-accent focus-visible:outline-accent rounded-sm focus-visible:outline-1 disabled:opacity-50"
            aria-describedby="notify-optin-desc"
          />
          <span className="text-ink font-mono text-sm">
            Notify me about new missions on this repo
          </span>
        </label>
        <p id="notify-optin-desc" className="sr-only">
          When checked, you will receive GitHub issue notifications for new missions found in this
          repository.
        </p>
        <button
          type="submit"
          disabled={state.kind === "submitting"}
          className="bg-accent shrink-0 rounded-xs px-3 py-1.5 font-mono text-sm text-white disabled:opacity-50"
        >
          {state.kind === "submitting" ? "Submitting…" : "Submit repo"}
        </button>
      </div>
    </form>
  );
}
