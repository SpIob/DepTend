"use client";

import { useState, memo } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import type { MissionStatus, MissionType, ScoreConfidence } from "@deptend/core/db/schema.js";
import type { MissionWithScore } from "@deptend/core";
import { SeverityMark, severityBarClass } from "./severity-mark";
import { EcosystemBadge } from "./ecosystem-badge";
import { Tag } from "./tag";
import { EFFORT_LABELS } from "@/lib/mission-filter-options";
import { extractErrorMessage } from "@/lib/fetch-error";
import { signInWithGitHub } from "@/lib/sign-in";

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

const MISSION_TYPE_LABELS: Record<MissionType, string> = {
  vulnerability_fix: "Vulnerability Fix",
  dep_update: "Dependency Update",
  maintenance: "Maintenance",
  license_issue: "License Issue",
};

const MISSION_TYPE_CLASS: Record<MissionType, string> = {
  vulnerability_fix: "bg-severity-high/10 text-severity-high border-severity-high/20",
  dep_update: "bg-accent/10 text-accent border-accent/20",
  maintenance: "bg-severity-medium/10 text-severity-medium border-severity-medium/20",
  license_issue: "bg-severity-low/10 text-severity-low border-severity-low/20",
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

/**
 * Claim/unclaim/dismiss/undismiss UI for one mission — a self-contained
 * fetch + request-state component, same pattern as SubmitRepoForm. Only
 * rendered content changes based on mission.status and the signed-in user's
 * login. After a successful mutation the parent is told via onStatusChange
 * so a parent-owned copy of the mission list stays in sync without a full
 * page reload; when no parent copy exists (the server-rendered paginated
 * board, ADR 0031), a router.refresh() re-syncs the card from the database
 * instead.
 *
 * Dismissal is open to any signed-in user on OPEN missions only (a claimed
 * mission belongs to its claimant; the pipeline auto-resolves missions whose
 * underlying vulnerability disappears). Undismiss restores a dismissed one.
 */
function MissionActions({
  missionId,
  status,
  claimedBy,
  onStatusChange,
}: {
  missionId: string;
  status: MissionStatus;
  claimedBy: string | null;
  onStatusChange?: ((missionId: string, patch: MissionClaimPatch) => void) | undefined;
}): React.JSX.Element {
  const { data: session } = useSession();
  const router = useRouter();
  const [request, setRequest] = useState<ClaimRequestState>({ kind: "idle" });
  const login = session?.user?.login;

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
      } else {
        router.refresh();
      }
    } catch {
      setRequest({ kind: "error", message: "Network error — try again." });
    }
  }

  const pending = request.kind === "pending";
  const errorMessage = request.kind === "error" ? request.message : null;

  if (status === "dismissed") {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-ink-muted font-mono text-xs">Dismissed</p>
        {login !== undefined && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void callAction("undismiss", { status: "open", claimedBy: null, claimedAt: null })
            }
            className="border-border text-ink-muted hover:text-ink hover:border-ink-muted w-fit rounded-md border px-2.5 py-1 font-mono text-xs disabled:opacity-50"
          >
            {pending ? "Restoring…" : "Restore"}
          </button>
        )}
        <div role="alert">
          {errorMessage !== null && <p className="text-status-error text-xs">{errorMessage}</p>}
        </div>
      </div>
    );
  }

  if (status === "claimed" && claimedBy === login) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            void callAction("unclaim", { status: "open", claimedBy: null, claimedAt: null })
          }
          className="border-border text-ink-muted hover:text-ink hover:border-ink-muted w-fit rounded-md border px-2.5 py-1 font-mono text-xs disabled:opacity-50"
        >
          {pending ? "Releasing…" : "Unclaim"}
        </button>
        <div role="alert">
          {errorMessage !== null && <p className="text-status-error text-xs">{errorMessage}</p>}
        </div>
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
          onClick={() => void signInWithGitHub()}
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
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            void callAction("claim", { status: "claimed", claimedBy: login, claimedAt: new Date() })
          }
          className="bg-accent w-fit rounded-md px-2.5 py-1 font-mono text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Claiming…" : "Claim this mission"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            void callAction("dismiss", { status: "dismissed", claimedBy: null, claimedAt: null })
          }
          className="border-border text-ink-muted hover:text-ink hover:border-ink-muted w-fit rounded-md border px-2.5 py-1 font-mono text-xs disabled:opacity-50"
        >
          {pending ? "Working…" : "Dismiss"}
        </button>
      </div>
      <div role="alert">
        {errorMessage !== null && <p className="text-status-error text-xs">{errorMessage}</p>}
      </div>
    </div>
  );
}

/**
 * The fix-target tag shown next to the title. This is the one thing that
 * reliably differs between two advisories against the same package at the
 * same severity — mission-copy.ts's buildTitle() produces an identical
 * string for both ("Update golang.org/x/crypto to fix a critical
 * vulnerability") regardless of which CVE it is — so it's what actually
 * lets otherwise-identical rows read as distinct at a glance, without
 * touching mission-copy.ts itself.
 *
 * The visible "Fix: {version}" is the source of truth for screen
 * readers too. The earlier shape (`aria-label` on a span with
 * `aria-hidden` on the visible text) left the visible content announced
 * nowhere and only worked for screen readers that happen to read
 * title-attr labels.
 */
function FixedVersionTag({ version }: { version: string }): React.JSX.Element {
  return (
    <span className="border-border bg-bg text-ink shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[11px]">
      Fix: {version}
    </span>
  );
}

export function MissionCard({
  mission,
  onStatusChange,
}: {
  mission: MissionWithScore;
  /**
   * Optional so server-rendered boards can omit it — see ClaimAction's
   * docstring: absent means claim/unclaim re-syncs via router.refresh().
   */
  onStatusChange?: ((missionId: string, patch: MissionClaimPatch) => void) | undefined;
}): React.JSX.Element {
  const { score, advisory, dependency, repo } = mission;
  const severity = advisory?.severity ?? "unknown";
  const isLowConfidence = score.confidence === "low";
  const isClaimed = mission.status === "claimed";
  const priorityPct = Math.min(100, Math.max(0, (score.compositeScore / 10) * 100));

  return (
    <article className="border-border bg-surface hover:border-ink-muted/50 flex overflow-hidden rounded-md border transition-shadow hover:shadow-md">
      <span className={`w-1.5 shrink-0 ${severityBarClass(severity)}`} aria-hidden="true" />
      <details className="group/card min-w-0 flex-1">
        <summary className="hover:bg-bg flex flex-col gap-2 px-3.5 py-2.5 focus-visible:outline-offset-[-2px] sm:flex-row sm:items-start sm:gap-2.5">
          <div className="flex items-start gap-2.5">
            <span
              className="text-ink-muted mt-0.5 shrink-0 font-mono text-xs transition-transform group-open/card:rotate-90"
              aria-hidden="true"
            >
              ▸
            </span>
            <SeverityMark severity={severity} />
            {dependency !== null && <EcosystemBadge ecosystem={dependency.ecosystem} />}
            <span
              className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[11px] ${
                MISSION_TYPE_CLASS[mission.missionType]
              }`}
            >
              {MISSION_TYPE_LABELS[mission.missionType]}
            </span>
          </div>

          <span className="flex min-w-0 flex-col gap-0.5 sm:flex-1">
            <span className="flex min-w-0 items-baseline gap-2">
              <h3 className="text-ink min-w-0 truncate text-sm font-semibold">{mission.title}</h3>
              {advisory?.fixedVersion != null && (
                <FixedVersionTag version={advisory.fixedVersion} />
              )}
            </span>
            {/* Plain text flow, not one flex item per fragment — lets the
                browser wrap at natural word boundaries ("Low effort ·"
                staying together) instead of every "·" and its neighbor
                landing on its own line on a narrow viewport. */}
            <p className="text-ink-muted font-mono text-[11px] leading-relaxed">
              {`${EFFORT_LABELS[score.effortLabel]} effort`} <span aria-hidden="true">·</span>{" "}
              {repo.owner}/{repo.name}
              {isLowConfidence && (
                <>
                  {" "}
                  <span aria-hidden="true">·</span>{" "}
                  <span className="text-severity-high font-semibold">⚠ low confidence</span>
                </>
              )}
            </p>
          </span>

          {isClaimed && (
            <Tag className="bg-accent/10 text-accent">Claimed · @{mission.claimedBy}</Tag>
          )}

          <span
            className="flex shrink-0 flex-row items-center gap-2 sm:flex-col sm:items-end sm:gap-1"
            // The score is the only quantitative signal on a card and
            // the preceding title-attr did not reach keyboard or many
            // screen readers. The bar has its own aria-hidden below
            // since it is pure decoration of the same number.
            aria-label={`Composite score ${score.compositeScore.toFixed(1)} out of 10`}
          >
            <span>
              <span className="text-accent font-mono text-2xl font-bold">
                {score.compositeScore.toFixed(1)}
              </span>
              <span className="text-ink-muted font-mono text-xs">/10</span>
            </span>
            <span
              className="bg-border block h-[3px] w-11 overflow-hidden rounded-full"
              aria-hidden="true"
            >
              <span
                className={`block h-full ${severityBarClass(severity)}`}
                style={{ width: `${priorityPct.toString()}%` }}
              />
            </span>
          </span>
        </summary>

        <div className="border-border/60 flex flex-col gap-3 border-t px-4 py-4">
          <p className="text-ink-muted whitespace-pre-line text-sm leading-relaxed">
            {mission.description}
          </p>

          {mission.actionHint !== null && (
            <p className="text-ink border-border border-l-2 pl-3 text-sm font-medium">
              {mission.actionHint}
            </p>
          )}

          <div className="text-ink-muted flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
            <span className={CONFIDENCE_CLASS[score.confidence]}>
              {isLowConfidence && "⚠ "}
              {CONFIDENCE_TEXT[score.confidence]}
            </span>
            <span aria-hidden="true">·</span>
            <a
              href={`https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`}
              className="hover:text-accent underline decoration-dotted underline-offset-2"
            >
              {repo.owner}/{repo.name}
            </a>
          </div>

          <MissionActions
            missionId={mission.id}
            status={mission.status}
            claimedBy={mission.claimedBy}
            onStatusChange={onStatusChange}
          />

          <details className="group/score -mx-4 -mb-4 mt-1">
            <summary className="text-ink-muted hover:text-ink hover:bg-bg border-border/60 flex items-center gap-1.5 border-t px-4 py-3 font-mono text-xs font-medium focus-visible:outline-offset-[-2px]">
              <span className="transition-transform group-open/score:rotate-90">▸</span>
              Why this score?
            </summary>
            <div className="bg-bg border-border/60 flex flex-col gap-4 border-t px-4 py-4 font-mono text-xs">
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
                <div
                  className={
                    isLowConfidence
                      ? "border-severity-high/40 bg-severity-high/10 rounded-sm border-l-2 px-3 py-2"
                      : ""
                  }
                >
                  <p
                    className={`mb-1 uppercase ${isLowConfidence ? "text-severity-high font-semibold" : "text-ink-muted"}`}
                  >
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
      </details>
    </article>
  );
}

function areMissionsEqual(
  prev: {
    mission: MissionWithScore;
    onStatusChange?: ((missionId: string, patch: MissionClaimPatch) => void) | undefined;
  },
  next: {
    mission: MissionWithScore;
    onStatusChange?: ((missionId: string, patch: MissionClaimPatch) => void) | undefined;
  },
): boolean {
  // Mission identity is stable — only re-render if the mission data actually changed
  if (prev.mission.id !== next.mission.id) return false;
  if (prev.mission.status !== next.mission.status) return false;
  if (prev.mission.claimedBy !== next.mission.claimedBy) return false;
  if (prev.mission.claimedAt?.getTime() !== next.mission.claimedAt?.getTime()) return false;
  if (prev.mission.score.compositeScore !== next.mission.score.compositeScore) return false;
  if (prev.mission.score.confidence !== next.mission.score.confidence) return false;
  // onStatusChange is a stable function reference from parent
  return prev.onStatusChange === next.onStatusChange;
}

export const MissionCardMemo = memo(MissionCard, areMissionsEqual);
