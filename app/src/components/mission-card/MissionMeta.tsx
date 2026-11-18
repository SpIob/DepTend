"use client";

import type { MissionWithScore } from "@deptend/core";
import { CONFIDENCE_TEXT, CONFIDENCE_CLASS } from "./constants";

interface MissionMetaProps {
  mission: MissionWithScore;
}

export function MissionMeta({ mission }: MissionMetaProps): React.JSX.Element {
  const { score, repo } = mission;
  const isLowConfidence = score.confidence === "low";
  const isRepoOwner =
    mission.claimedBy !== null && mission.claimedBy === repo.owner && repo.orgId === null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-ink-muted">
      <span className={CONFIDENCE_CLASS[score.confidence]}>
        {isLowConfidence && "⚠ "}
        {CONFIDENCE_TEXT[score.confidence]}
      </span>
      <span aria-hidden="true">·</span>
      <a
        href={`https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`}
        className="underline decoration-dotted underline-offset-2 hover:text-accent"
      >
        {repo.owner}/{repo.name}
      </a>
      {mission.prUrl !== null && (
        <>
          <span aria-hidden="true">·</span>
          <a
            href={mission.prUrl}
            className="underline decoration-dotted underline-offset-2 hover:text-accent"
            aria-label={`Fix pull request: ${mission.prUrl}`}
          >
            fix PR ↗
          </a>
        </>
      )}
      {isRepoOwner && (
        <span
          className="inline-flex items-center rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-ink-muted"
          aria-label="Mission claimed by the repository owner"
        >
          repo owner
        </span>
      )}
    </div>
  );
}
