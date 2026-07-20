import type { EffortLabel, Severity } from "@deptend/core/db/schema.js";

const SEVERITY_OPTIONS: readonly Severity[] = ["critical", "high", "medium", "low", "unknown"];
const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  unknown: "Unknown",
};

const EFFORT_OPTIONS: readonly EffortLabel[] = ["trivial", "low", "medium", "high"];
const EFFORT_LABELS: Record<EffortLabel, string> = {
  trivial: "Trivial",
  low: "Low",
  medium: "Medium",
  high: "High",
};

function Chip({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
        active
          ? "border-accent bg-accent text-white"
          : "border-border text-ink-muted hover:text-ink hover:border-ink-muted"
      }`}
    >
      {label}
    </button>
  );
}

export function MissionFilterBar({
  selectedSeverities,
  onToggleSeverity,
  selectedEfforts,
  onToggleEffort,
  onClear,
}: {
  selectedSeverities: ReadonlySet<Severity>;
  onToggleSeverity: (severity: Severity) => void;
  selectedEfforts: ReadonlySet<EffortLabel>;
  onToggleEffort: (effort: EffortLabel) => void;
  onClear: () => void;
}): React.JSX.Element {
  const hasFilters = selectedSeverities.size > 0 || selectedEfforts.size > 0;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-muted w-14 shrink-0 font-mono text-xs uppercase tracking-wide">
          Impact
        </span>
        {SEVERITY_OPTIONS.map((severity) => (
          <Chip
            key={severity}
            label={SEVERITY_LABELS[severity]}
            active={selectedSeverities.has(severity)}
            onToggle={() => {
              onToggleSeverity(severity);
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-muted w-14 shrink-0 font-mono text-xs uppercase tracking-wide">
          Effort
        </span>
        {EFFORT_OPTIONS.map((effort) => (
          <Chip
            key={effort}
            label={EFFORT_LABELS[effort]}
            active={selectedEfforts.has(effort)}
            onToggle={() => {
              onToggleEffort(effort);
            }}
          />
        ))}
      </div>
      {hasFilters && (
        <button
          type="button"
          onClick={onClear}
          className="text-accent hover:text-ink self-start font-mono text-xs underline decoration-dotted underline-offset-2"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
