"use client";

import type { MissionWithScore } from "@deptend/core";
import { SeverityMark } from "../severity-mark";
import { shortOsvId } from "./utils";
import { FixedVersionTag } from "./FixedVersionTag";

interface MissionHeaderProps {
  mission: MissionWithScore;
}

export function MissionHeader({ mission }: MissionHeaderProps): React.JSX.Element {
  const { score, advisory } = mission;
  const severity = advisory?.severity ?? "unknown";
  const osvShortId = advisory === null ? null : shortOsvId(advisory.osvId);

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
      </span>

      <span className="flex shrink-0 items-center">
        <span
          className="text-accent font-mono text-xl font-bold"
          aria-label={`Composite score ${score.compositeScore.toFixed(1)} out of 10`}
        >
          {score.compositeScore.toFixed(1)}
        </span>
        <span className="text-ink-muted ml-1 font-mono text-xs">/10</span>
      </span>
    </div>
  );
}
