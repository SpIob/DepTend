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
      {isRepoOwner && (
        <span
          className="border-border bg-surface text-ink-muted inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px]"
          aria-label="Mission claimed by the repository owner"
        >
          repo owner
        </span>
      )}
    </div>
  );
}
