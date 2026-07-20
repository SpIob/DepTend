"use client";

import { useState } from "react";
import { signIn, useSession } from "next-auth/react";
import type { EffortLabel, MissionStatus, ScoreConfidence } from "@deptend/core/db/schema.js";
import type { MissionWithScore } from "@deptend/core";
import { SeverityMark, severityBorderClass } from "./severity-mark";

const EFFORT_LABEL_TEXT: Record<EffortLabel, string> = {
  trivial: "Trivial effort",
  low: "Low effort",
  medium: "Medium effort",
  high: "High effort",
};

const CONFIDENCE_TEXT: Record<ScoreConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

const CONFIDENCE_CLASS: Record<ScoreConfidence, string> = {
  high: "text-ink-muted",
  medium: "text-severity-medium",
  low: "text-severity-high",
};

function osvUrl(osvId: string): string {
  return `https://osv.dev/vulnerability/${encodeURIComponent(osvId)}`;
}

/** What changes on a mission after a successful claim/unclaim call. */
export interface MissionClaimPatch {
  status: MissionStatus;
  claimedBy: string | null;
  claimedAt: Date | null;
}

type ClaimRequestState =
  { kind: "idle" } | { kind: "pending" } | { kind: "error"; message: string };

function extractErrorMessage(data: unknown): string | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  return typeof record.error === "string" ? record.error : null;
}

/**
 * Claim/unclaim UI for one mission — a self-contained fetch + request-state
 * component, same pattern as SubmitRepoForm. Only rendered content changes
 * based on mission.status and the signed-in user's login; the parent
 * (MissionBoard) is told about a successful mutation via onStatusChange so
 * its copy of the mission list stays in sync without a full page reload.
 */
function ClaimAction({
  missionId,
  status,
  claimedBy,
  onStatusChange,
}: {
  missionId: string;
  status: MissionStatus;
  claimedBy: string | null;
  onStatusChange: (missionId: string, patch: MissionClaimPatch) => void;
}): React.JSX.Element | null {
  const { data: session } = useSession();
  const [request, setRequest] = useState<ClaimRequestState>({ kind: "idle" });
  const login = session?.user?.login;

  async function callAction(action: "claim" | "unclaim", patch: MissionClaimPatch): Promise<void> {
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
      onStatusChange(missionId, patch);
    } catch {
      setRequest({ kind: "error", message: "Network error — try again." });
    }
  }

  const pending = request.kind === "pending";
  const errorMessage = request.kind === "error" ? request.message : null;

  if (status === "claimed" && claimedBy === login) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            void callAction("unclaim", { status: "open", claimedBy: null, claimedAt: null })
          }
          className="border-border text-ink-muted hover:text-ink hover:border-ink-muted w-fit rounded-sm border px-2.5 py-1 font-mono text-xs disabled:opacity-50"
        >
          {pending ? "Releasing…" : "Unclaim"}
        </button>
        {errorMessage !== null && <p className="text-severity-critical text-xs">{errorMessage}</p>}
      </div>
    );
  }

  if (status === "claimed") {
    return (
      <p className="text-ink-muted font-mono text-xs">
        Claimed by <span className="text-ink font-medium">@{claimedBy}</span>
      </p>
    );
  }

  // status === "open" from here down.
  if (login === undefined) {
    return (
      <p className="text-ink-muted text-xs">
        <button
          type="button"
          onClick={() => void signIn("github")}
          className="text-accent hover:text-ink underline decoration-dotted underline-offset-2"
        >
          Sign in with GitHub
        </button>{" "}
        to claim this mission.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          void callAction("claim", { status: "claimed", claimedBy: login, claimedAt: new Date() })
        }
        className="bg-accent w-fit rounded-sm px-2.5 py-1 font-mono text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Claiming…" : "Claim this mission"}
      </button>
      {errorMessage !== null && <p className="text-severity-critical text-xs">{errorMessage}</p>}
    </div>
  );
}

export function MissionCard({
  mission,
  onStatusChange,
}: {
  mission: MissionWithScore;
  onStatusChange: (missionId: string, patch: MissionClaimPatch) => void;
}): React.JSX.Element {
  const { score, advisory, dependency, repo } = mission;
  const severity = advisory?.severity ?? "unknown";
  const isLowConfidence = score.confidence === "low";

  return (
    <article
      className={`border-border bg-surface border border-l-4 ${severityBorderClass(severity)} rounded-sm ${mission.status === "claimed" ? "opacity-75" : ""}`}
    >
      <div className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex flex-col gap-1.5">
            <SeverityMark severity={severity} />
            <h2 className="text-ink text-balance text-base font-semibold leading-snug">
              {mission.title}
            </h2>
          </div>
          <div className="flex shrink-0 items-baseline gap-2 font-mono">
            <span className="text-accent text-2xl font-bold" title="Composite score, out of 10">
              {score.compositeScore.toFixed(1)}
            </span>
            <span className="text-ink-muted text-xs">/10</span>
          </div>
        </div>

        <p className="text-ink-muted whitespace-pre-line text-sm leading-relaxed">
          {mission.description}
        </p>

        {mission.actionHint !== null && (
          <p className="text-ink border-border border-l-2 pl-3 text-sm font-medium">
            {mission.actionHint}
          </p>
        )}

        <div className="text-ink-muted flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs">
          <span>{EFFORT_LABEL_TEXT[score.effortLabel]}</span>
          <span aria-hidden="true">·</span>
          <span className={isLowConfidence ? "font-semibold" : ""}>
            <span className={CONFIDENCE_CLASS[score.confidence]}>
              {isLowConfidence && "⚠ "}
              {CONFIDENCE_TEXT[score.confidence]}
            </span>
          </span>
          <span aria-hidden="true">·</span>
          <a
            href={`https://github.com/${repo.owner}/${repo.name}`}
            className="hover:text-accent underline decoration-dotted underline-offset-2"
          >
            {repo.owner}/{repo.name}
          </a>
        </div>

        <ClaimAction
          missionId={mission.id}
          status={mission.status}
          claimedBy={mission.claimedBy}
          onStatusChange={onStatusChange}
        />

        <details className="group -mx-5 -mb-5 mt-1">
          <summary className="text-ink-muted hover:text-ink hover:bg-bg border-border/60 flex items-center gap-1.5 border-t px-5 py-3 font-mono text-xs font-medium">
            <span className="transition-transform group-open:rotate-90">▸</span>
            Why this score?
          </summary>
          <div className="bg-bg border-border/60 flex flex-col gap-4 border-t px-5 py-4 font-mono text-xs">
            <div>
              <p className="text-ink-muted mb-1 uppercase">Formula</p>
              <p className="text-ink">
                0.60 × impact ({score.impactScore.toFixed(1)}) + 0.40 × ecosystem value (
                {score.ecosystemValueScore.toFixed(1)}) = {score.compositeScore.toFixed(1)}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <p className="text-ink-muted mb-1 uppercase">Impact inputs</p>
                <ul className="text-ink flex flex-col gap-0.5">
                  <li>
                    CVSS:{" "}
                    {score.impactInputs.cvss_score !== null
                      ? score.impactInputs.cvss_score.toFixed(1)
                      : "unknown"}
                  </li>
                  <li>Severity: {score.impactInputs.severity}</li>
                  <li>Dependency type: {score.impactInputs.dep_type}</li>
                  <li>
                    Advisory age:{" "}
                    {score.impactInputs.days_since_advisory !== null
                      ? `${score.impactInputs.days_since_advisory.toString()}d`
                      : "unknown"}
                  </li>
                </ul>
              </div>

              <div>
                <p className="text-ink-muted mb-1 uppercase">Ecosystem value inputs</p>
                <ul className="text-ink flex flex-col gap-0.5">
                  <li>Repo stars: {score.ecosystemValueInputs.repo_stars.toLocaleString()}</li>
                  <li>Open issues: {score.ecosystemValueInputs.open_issues_count}</li>
                  <li>
                    Downstream dependents:{" "}
                    {score.ecosystemValueInputs.downstream_dependents ?? "not tracked yet"}
                  </li>
                </ul>
              </div>

              <div>
                <p className="text-ink-muted mb-1 uppercase">Effort inputs</p>
                <ul className="text-ink flex flex-col gap-0.5">
                  <li>Semver bump: {score.effortInputs.semver_bump}</li>
                  <li>
                    Migration guide:{" "}
                    {score.effortInputs.has_migration_guide ? "available" : "not tracked yet"}
                  </li>
                </ul>
              </div>
            </div>

            {score.confidenceNotes !== null && score.confidenceNotes.length > 0 && (
              <div>
                <p className="text-ink-muted mb-1 uppercase">
                  Why {CONFIDENCE_TEXT[score.confidence].toLowerCase()}
                </p>
                <ul className="text-ink flex flex-col gap-0.5">
                  {score.confidenceNotes.map((note) => (
                    <li key={note}>· {note}</li>
                  ))}
                </ul>
              </div>
            )}

            {advisory !== null && (
              <div>
                <p className="text-ink-muted mb-1 uppercase">Source</p>
                <p className="text-ink">
                  {advisory.source.toUpperCase()} advisory{" "}
                  <a
                    href={osvUrl(advisory.osvId)}
                    className="text-accent underline decoration-dotted underline-offset-2"
                  >
                    {advisory.osvId}
                  </a>
                  {dependency !== null && <> for {dependency.packageName}</>}
                </p>
              </div>
            )}
          </div>
        </details>
      </div>
    </article>
  );
}
