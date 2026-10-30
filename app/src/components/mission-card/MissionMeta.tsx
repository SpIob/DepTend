"use client";

import type { MissionWithScore } from "@deptend/core";
import { CONFIDENCE_TEXT, CONFIDENCE_CLASS } from "./constants";

interface MissionMetaProps {
  mission: MissionWithScore;
}

export function MissionMeta({ mission }: MissionMetaProps): React.JSX.Element {
  const { score, repo } = mission;
  const isLowConfidence = score.confidence === "low";

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
    </div>
  );
}
