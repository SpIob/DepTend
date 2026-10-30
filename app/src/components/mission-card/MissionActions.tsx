"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import type { MissionStatus } from "@deptend/core/db/schema.js";
import { extractErrorMessage } from "@/lib/fetch-error";
import { signInWithGitHub } from "@/lib/sign-in";
import type { MissionClaimPatch, MissionActionMode, ClaimRequestState } from "./types";
import { computeMode } from "./utils";

interface MissionActionsProps {
  missionId: string;
  status: MissionStatus;
  claimedBy: string | null;
  onStatusChange?: ((missionId: string, patch: MissionClaimPatch) => void) | undefined;
}

export function MissionActions({
  missionId,
  status,
  claimedBy,
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
