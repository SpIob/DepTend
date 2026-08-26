import type { Ecosystem, EffortLabel, Severity } from "@deptend/core/db/schema.js";
import {
  ECOSYSTEM_LABELS,
  ECOSYSTEM_OPTIONS,
  EFFORT_LABELS,
  EFFORT_OPTIONS,
  SEVERITY_LABELS,
  SEVERITY_OPTIONS,
} from "@/lib/mission-filter-options";

function Chip({
  label,
  count,
  active,
  onToggle,
}: {
  label: string;
  count: number | undefined;
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
      {count !== undefined ? ` (${count.toString()})` : ""}
    </button>
  );
}

export function MissionFilterBar({
  selectedSeverities,
  onToggleSeverity,
  severityCounts,
  selectedEcosystems,
  onToggleEcosystem,
  ecosystemCounts,
  selectedEfforts,
  onToggleEffort,
  effortCounts,
  hideEcosystemAxis = false,
  onClear,
}: {
  selectedSeverities: ReadonlySet<Severity>;
  onToggleSeverity: (severity: Severity) => void;
  severityCounts: Partial<Record<Severity, number>>;
  selectedEcosystems: ReadonlySet<Ecosystem>;
  onToggleEcosystem: (ecosystem: Ecosystem) => void;
  ecosystemCounts: Partial<Record<Ecosystem, number>>;
  selectedEfforts: ReadonlySet<EffortLabel>;
  onToggleEffort: (effort: EffortLabel) => void;
  effortCounts: Partial<Record<EffortLabel, number>>;
  /**
   * Hides the ecosystem chip row — for boards where the axis carries no
   * information (a per-repo board whose missions are all one ecosystem).
   * Forced off while an ecosystem filter is active, so a URL-supplied
   * selection can never become an invisible filter.
   */
  hideEcosystemAxis?: boolean;
  onClear: () => void;
}): React.JSX.Element {
  const hasFilters =
    selectedSeverities.size > 0 || selectedEcosystems.size > 0 || selectedEfforts.size > 0;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-muted w-20 shrink-0 font-mono text-xs uppercase tracking-wide">
          Impact
        </span>
        {SEVERITY_OPTIONS.map((severity) => (
          <Chip
            key={severity}
            label={SEVERITY_LABELS[severity]}
            count={severityCounts[severity]}
            active={selectedSeverities.has(severity)}
            onToggle={() => {
              onToggleSeverity(severity);
            }}
          />
        ))}
      </div>
      {!hideEcosystemAxis && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink-muted w-20 shrink-0 font-mono text-xs uppercase tracking-wide">
            Ecosystem
          </span>
          {ECOSYSTEM_OPTIONS.map((ecosystem) => (
            <Chip
              key={ecosystem}
              label={ECOSYSTEM_LABELS[ecosystem]}
              count={ecosystemCounts[ecosystem]}
              active={selectedEcosystems.has(ecosystem)}
              onToggle={() => {
                onToggleEcosystem(ecosystem);
              }}
            />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-muted w-20 shrink-0 font-mono text-xs uppercase tracking-wide">
          Effort
        </span>
        {EFFORT_OPTIONS.map((effort) => (
          <Chip
            key={effort}
            label={EFFORT_LABELS[effort]}
            count={effortCounts[effort]}
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
