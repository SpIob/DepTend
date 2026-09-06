import type { ScoreConfidence, MissionType } from "@deptend/core/db/schema.js";

export const CONFIDENCE_TEXT: Record<ScoreConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

export const CONFIDENCE_CLASS: Record<ScoreConfidence, string> = {
  high: "text-ink-muted",
  medium: "text-severity-medium",
  low: "text-ink-muted",
};

export const MISSION_TYPE_CLASS: Record<MissionType, string> = {
  vulnerability_fix: "bg-severity-high/10 text-severity-high border-severity-high/20",
  dep_update: "bg-accent/10 text-accent border-accent/20",
  maintenance: "bg-severity-medium/10 text-severity-medium border-severity-medium/20",
  license_issue: "bg-severity-low/10 text-severity-low border-severity-low/20",
};

export const CONFIDENCE_NOTES_BLOCK =
  "border-severity-high/40 bg-severity-high/10 rounded-sm border-l-2 px-3 py-2";

export const CONFIDENCE_NOTES_HEADING =
  "text-ink-muted mb-1 font-mono text-xs font-semibold uppercase tracking-wide";

export const CONFIDENCE_NOTES_HEADING_DEFAULT =
  "text-ink-muted mb-1 font-mono text-xs uppercase tracking-wide";

export const CHIP_ACTIVE_CLASS = "border-accent bg-accent text-white";
export const CHIP_IDLE_CLASS = "border-border text-ink-muted hover:text-ink hover:border-ink-muted";
