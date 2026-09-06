"use client";

import { memo } from "react";
import type { MissionWithScore } from "@deptend/core";
import type { MissionClaimPatch } from "./types";
import { MissionHeader } from "./MissionHeader";
import { MissionMeta } from "./MissionMeta";
import { MissionActions } from "./MissionActions";
import { MissionScoreDetails } from "./MissionScoreDetails";
import { areMissionsEqual } from "./memo-comparator";

export function MissionCard({
  mission,
  onStatusChange,
}: {
  mission: MissionWithScore;
  onStatusChange?: ((missionId: string, patch: MissionClaimPatch) => void) | undefined;
}): React.JSX.Element {
  const { score, advisory, dependency } = mission;
  const severity = advisory?.severity ?? "unknown";
  const isLowConfidence = score.confidence === "low";

  return (
    <article className="border-border bg-surface hover:border-ink-muted/50 flex overflow-hidden rounded-md border transition-shadow hover:shadow-md">
      <span
        className={`w-1.5 shrink-0 ${severity === "critical" ? "bg-severity-high" : severity === "high" ? "bg-severity-high" : severity === "medium" ? "bg-severity-medium" : severity === "low" ? "bg-severity-low" : "bg-severity-unknown"}`}
        aria-hidden="true"
      />
      <details className="group/card min-w-0 flex-1">
        <summary className="hover:bg-bg flex flex-col gap-2 px-3.5 py-2.5 focus-visible:outline-offset-[-2px] sm:flex-row sm:items-start sm:gap-2.5">
          <MissionHeader mission={mission} />
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

          <MissionMeta mission={mission} />

          <MissionActions
            missionId={mission.id}
            status={mission.status}
            claimedBy={mission.claimedBy}
            onStatusChange={onStatusChange}
          />

          <MissionScoreDetails
            score={score}
            isLowConfidence={isLowConfidence}
            advisory={advisory}
            dependency={dependency}
          />
        </div>
      </details>
    </article>
  );
}

export const MissionCardMemo = memo(MissionCard, areMissionsEqual);
