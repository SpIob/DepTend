"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import type { MissionStatus } from "@deptend/core/db/schema.js";
import { extractErrorMessage } from "@/lib/fetch-error";
import { signInWithGitHub } from "@/lib/sign-in";
import type {
  MissionClaimPatch,
  MissionPatch,
  MissionActionMode,
  ClaimRequestState,
} from "./types";
import { computeMode } from "./utils";

interface MissionActionsProps {
  missionId: string;
  status: MissionStatus;
  claimedBy: string | null;
  prUrl: string | null;
  onStatusChange?: ((missionId: string, patch: MissionPatch) => void) | undefined;
}

/**
 * Inline editor for the claimed mission's fix-PR link (ADR 0068). Rendered
 * only in the claimed-by-me branch — core's setMissionPrUrl enforces the
 * same claimant-only rule server-side, so a stale UI can at worst get a 409.
 * An empty input means "clear the link".
 */
function PrLinkEditor({
  missionId,
  prUrl,
  onSaved,
}: {
  missionId: string;
  prUrl: string | null;
  onSaved: (prUrl: string | null) => void;
}): React.JSX.Element {
  const [value, setValue] = useState(prUrl ?? "");
  const [state, setState] = useState<ClaimRequestState>({ kind: "idle" });
  const busy = state.kind === "pending";
  const isClearing = value.trim() === "" && prUrl !== null;

  async function handleSave(): Promise<void> {
    setState({ kind: "pending" });
    const trimmed = value.trim();
    const nextUrl = trimmed === "" ? null : trimmed;
    try {
      const response = await fetch(`/api/missions/${missionId}/pr-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl: nextUrl }),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        setState({
          kind: "error",
          message: extractErrorMessage(data) ?? "Something went wrong.",
        });
        return;
      }
      setState({ kind: "idle" });
      onSaved(nextUrl);
    } catch {
      setState({ kind: "error", message: "Network error — try again." });
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`pr-url-${missionId}`} className="sr-only">
        Pull request URL
      </label>
      <div className="flex items-center gap-2">
        <input
          id={`pr-url-${missionId}`}
          type="text"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
          disabled={busy}
          placeholder="https://github.com/owner/repo/pull/N"
          className="w-full max-w-xs rounded-sm border border-border bg-surface px-2 py-1 font-mono text-xs text-ink placeholder:text-ink-muted focus-visible:outline-accent"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleSave()}
          className="w-fit shrink-0 rounded-md border border-border px-2.5 py-1 font-mono text-xs text-ink-muted hover:border-ink-muted hover:text-ink disabled:opacity-50"
        >
          {busy ? "Saving…" : isClearing ? "Remove link" : "Save PR link"}
        </button>
      </div>
      <p className="text-[10px] text-ink-muted">
        Paste the fix's pull-request URL so the board links to it. Leave empty to remove.
      </p>
      <div role="alert">
        {state.kind === "error" && <p className="text-xs text-status-error">{state.message}</p>}
      </div>
    </div>
  );
}

export function MissionActions({
  missionId,
  status,
  claimedBy,
  prUrl,
  onStatusChange,
}: MissionActionsProps): React.JSX.Element {
  const { data: session } = useSession();
  const [request, setRequest] = useState<ClaimRequestState>({ kind: "idle" });
  const login = session?.user?.login;

  const mode: MissionActionMode = computeMode(status, claimedBy, login);

  async function callAction(
    action: "claim" | "unclaim" | "dismiss" | "undismiss",
    patch: MissionClaimPatch,
  ): Promise<void> {
    setRequest({ kind: "pending" });
    try {
      const response = await fetch(`/api/missions/${missionId}/${action}`, { method: "POST" });
      const data: unknown = await response.json();
      if (!response.ok) {
        setRequest({
          kind: "error",
          message: extractErrorMessage(data) ?? "Something went wrong.",
        });
        return;
      }
      setRequest({ kind: "idle" });
      if (onStatusChange !== undefined) {
        onStatusChange(missionId, patch);
      }
    } catch {
      setRequest({ kind: "error", message: "Network error — try again." });
    }
  }

  const pending = request.kind === "pending";
  const errorMessage = request.kind === "error" ? request.message : null;
  const errorAlert = (
    <div role="alert">
      {errorMessage !== null && <p className="text-xs text-status-error">{errorMessage}</p>}
    </div>
  );

  switch (mode) {
    case "open-claimable":
      return (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void callAction("claim", {
                  status: "claimed",
                  claimedBy: login ?? null,
                  claimedAt: new Date(),
                })
              }
              className="w-fit rounded-md bg-accent px-2.5 py-1 font-mono text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {pending ? "Claiming…" : "Claim this mission"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void callAction("dismiss", {
                  status: "dismissed",
                  claimedBy: null,
                  claimedAt: null,
                })
              }
              className="w-fit rounded-md border border-border px-2.5 py-1 font-mono text-xs text-ink-muted hover:border-ink-muted hover:text-ink disabled:opacity-50"
            >
              {pending ? "Working…" : "Dismiss"}
            </button>
          </div>
          {errorAlert}
        </div>
      );

    case "open-signed-out":
      return (
        <p className="text-xs text-ink-muted">
          <button
            type="button"
            onClick={() => void signInWithGitHub()}
            className="text-accent underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            Sign in with GitHub
          </button>{" "}
          to claim this mission.
        </p>
      );

    case "claimed-by-me":
      return (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void callAction("unclaim", { status: "open", claimedBy: null, claimedAt: null })
            }
            className="w-fit rounded-md border border-border px-2.5 py-1 font-mono text-xs text-ink-muted hover:border-ink-muted hover:text-ink disabled:opacity-50"
          >
            {pending ? "Releasing…" : "Unclaim"}
          </button>
          <PrLinkEditor
            missionId={missionId}
            prUrl={prUrl}
            onSaved={(nextUrl) => {
              if (onStatusChange !== undefined) {
                onStatusChange(missionId, { prUrl: nextUrl });
              }
            }}
          />
          {errorAlert}
        </div>
      );

    case "claimed-by-other":
      return (
        <p className="font-mono text-xs text-ink-muted">
          Claimed by <span className="font-medium text-ink">@{claimedBy}</span>
        </p>
      );

    case "dismissed-by-me":
      return (
        <div className="flex flex-col gap-1">
          <p className="font-mono text-xs text-ink-muted">Dismissed</p>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void callAction("undismiss", { status: "open", claimedBy: null, claimedAt: null })
            }
            className="w-fit rounded-md border border-border px-2.5 py-1 font-mono text-xs text-ink-muted hover:border-ink-muted hover:text-ink disabled:opacity-50"
          >
            {pending ? "Restoring…" : "Restore"}
          </button>
          {errorAlert}
        </div>
      );

    case "dismissed-signed-out":
      return <p className="font-mono text-xs text-ink-muted">Dismissed</p>;
  }
}
