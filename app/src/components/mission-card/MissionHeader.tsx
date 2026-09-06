"use client";

import type { MissionWithScore } from "@deptend/core";
import { SeverityMark, severityBarClass } from "../severity-mark";
import { EcosystemBadge } from "../ecosystem-badge";
import { Tag } from "../tag";
import { EFFORT_LABELS, MISSION_TYPE_LABELS } from "@/lib/mission-filter-options";
import { shortOsvId } from "./utils";
import { MISSION_TYPE_CLASS } from "./constants";
import { FixedVersionTag } from "./FixedVersionTag";

interface MissionHeaderProps {
  mission: MissionWithScore;
}

export function MissionHeader({ mission }: MissionHeaderProps): React.JSX.Element {
  const { score, advisory, dependency, repo } = mission;
  const severity = advisory?.severity ?? "unknown";
  const isLowConfidence = score.confidence === "low";
  const osvShortId = advisory === null ? null : shortOsvId(advisory.osvId);
  const priorityPct = Math.min(100, Math.max(0, (score.compositeScore / 10) * 100));

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-2.5">
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
          <h3 className="text-ink min-w-0 truncate text-sm font-semibold">
            {mission.title}
            {osvShortId !== null && (
              <span className="text-ink-muted ml-1 font-normal">({osvShortId})</span>
            )}
          </h3>
          {advisory?.fixedVersion != null && <FixedVersionTag version={advisory.fixedVersion} />}
        </span>
        <p className="text-ink-muted font-mono text-[11px] leading-relaxed">
          {`${EFFORT_LABELS[score.effortLabel]} effort`} <span aria-hidden="true">·</span>{" "}
          {repo.owner}/{repo.name}
          {isLowConfidence && (
            <>
              {" "}
              <span aria-hidden="true">·</span>{" "}
              <span className="text-ink font-semibold">⚠ low confidence</span>
            </>
          )}
        </p>
      </span>

      <span className="flex shrink-0 flex-col items-end gap-1 sm:flex-col-reverse">
        {mission.status === "claimed" && (
          <Tag className="bg-accent/10 text-accent">Claimed · @{mission.claimedBy}</Tag>
        )}
        <span
          className="flex flex-row items-center gap-2 sm:flex-col sm:items-end"
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
      </span>
    </div>
  );
}
