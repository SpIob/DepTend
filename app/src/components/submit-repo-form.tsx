"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { signInWithGitHub } from "@/lib/sign-in";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

function extractMessage(data: unknown): string | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.message === "string") {
    return record.message;
  }
  if (typeof record.error === "string") {
    return record.error;
  }
  return null;
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
      const message = extractMessage(data) ?? "Something went wrong.";

      if (response.ok) {
        setState({ kind: "success", message });
        setUrl("");
      } else {
        setState({ kind: "error", message });
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
          className="border-border bg-surface text-ink placeholder:text-ink-muted focus-visible:outline-accent w-full rounded-sm border px-3 py-1.5 font-mono text-sm"
        />
        <div role="status" aria-live="polite">
          {state.kind === "success" && (
            <p className="text-status-success text-xs">{state.message}</p>
          )}
          {state.kind === "error" && <p className="text-status-error text-xs">{state.message}</p>}
        </div>
      </div>
      <button
        type="submit"
        disabled={state.kind === "submitting"}
        className="bg-accent shrink-0 rounded-sm px-3 py-1.5 font-mono text-sm text-white disabled:opacity-50"
      >
        {state.kind === "submitting" ? "Submitting…" : "Submit repo"}
      </button>
    </form>
  );
}
