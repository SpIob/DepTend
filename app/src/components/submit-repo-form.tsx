"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { signInWithGitHub } from "@/lib/sign-in";
import { extractErrorMessage } from "@/lib/fetch-error";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

/** Pulls the success-path `message` string. The route's success body is
 *  `{ message, repo }` (see app/src/app/api/repos/route.ts); the error
 *  body is `{ error }` and goes through extractErrorMessage instead. */
function successMessage(data: unknown): string | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  return typeof record.message === "string" ? record.message : null;
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
        const message = successMessage(data) ?? "Submitted.";
        setState({ kind: "success", message });
        setUrl("");
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
      <p className="text-sm text-ink-muted">
        <button
          type="button"
          onClick={() => void signInWithGitHub()}
          className="text-accent underline decoration-dotted underline-offset-2 hover:text-ink"
        >
          Sign in with GitHub
        </button>{" "}
        to submit a repo.
      </p>
    );
  }

  if (atCap) {
    return (
      <p className="font-mono text-xs text-ink-muted">
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
          className="w-full rounded-sm border border-border bg-surface px-3 py-1.5 font-mono text-sm text-ink placeholder:text-ink-muted focus-visible:outline-accent"
        />
        <div role="status" aria-live="polite">
          {state.kind === "success" && (
            <p className="text-xs text-status-success">{state.message}</p>
          )}
          {state.kind === "error" && <p className="text-xs text-status-error">{state.message}</p>}
        </div>
      </div>
      <button
        type="submit"
        disabled={state.kind === "submitting"}
        className="shrink-0 rounded-sm bg-accent px-3 py-1.5 font-mono text-sm text-white disabled:opacity-50"
      >
        {state.kind === "submitting" ? "Submitting…" : "Submit repo"}
      </button>
    </form>
  );
}
