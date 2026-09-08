"use client";

import type { MissionBoardQuery, MissionBoardQueryState } from "@/lib/mission-board-query";
import { toggledSet } from "@/lib/mission-board-query";
import {
  ECOSYSTEM_LABELS,
  ECOSYSTEM_OPTIONS,
  EFFORT_LABELS,
  EFFORT_OPTIONS,
  MISSION_TYPE_LABELS,
  MISSION_TYPE_OPTIONS,
  SEVERITY_LABELS,
  SEVERITY_OPTIONS,
} from "@/lib/mission-filter-options";
import { CHIP_ACTIVE_CLASS, CHIP_IDLE_CLASS } from "./constants";
import type { BoardFacets } from "@deptend/core/db/queries.js";

function FilterChip({
  onToggle,
  label,
  count,
  active,
  disabled,
}: {
  onToggle: () => void;
  label: string;
  count: number | undefined;
  active: boolean;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={active}
      className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active ? CHIP_ACTIVE_CLASS : CHIP_IDLE_CLASS
      }`}
    >
      {label}
      {count !== undefined ? ` (${count.toString()})` : ""}
    </button>
  );
}

function EmptyFilterState(): React.JSX.Element {
  return (
    <div className="border-border bg-surface rounded-sm border border-dashed p-10 text-center">
      <p className="text-ink font-medium">No missions match these filters.</p>
      <p className="text-ink-muted mt-1 text-sm">Try clearing or loosening a filter above.</p>
    </div>
  );
}

function FilterRow<Option extends string>({
  label,
  options,
  labels,
  active,
  countFor,
  onToggle,
  disabled,
}: {
  label: string;
  options: readonly Option[];
  labels: Record<Option, string>;
  active: ReadonlySet<Option>;
  countFor: (option: Option) => number | undefined;
  /** Receives the toggled-value Set; the caller is responsible for
   *  turning it into a navigation (via buildHref + navigate). */
  onToggle: (next: Set<Option>) => void;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-ink-muted w-20 shrink-0 font-mono text-xs uppercase tracking-wide">
        {label}
      </span>
      {options.map((option) => (
        <FilterChip
          key={option}
          onToggle={() => {
            onToggle(toggledSet(active, option));
          }}
          label={labels[option]}
          count={countFor(option)}
          active={active.has(option)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

interface FilterChipsProps {
  initialQuery: MissionBoardQuery;
  facets: BoardFacets;
  isPending: boolean;
  navigate: (href: string) => void;
  buildHref: (overrides: MissionBoardQueryState) => string;
  /** Client mode: called with updated query instead of navigating */
  onFilterChange?: (nextQuery: Partial<MissionBoardQuery>) => void;
}

export function FilterChips({
  initialQuery,
  facets,
  isPending,
  navigate,
  buildHref,
  onFilterChange,
}: FilterChipsProps): React.JSX.Element {
  const isClientMode = typeof onFilterChange === "function";

  const makeOnToggle = <T extends string>(
    key: keyof MissionBoardQuery,
    _active: ReadonlySet<T>,
  ) => {
    return (next: Set<T>) => {
      if (isClientMode) {
        onFilterChange({ [key]: next } as Partial<MissionBoardQuery>);
      } else {
        navigate(buildHref({ [key]: next } as MissionBoardQueryState));
      }
    };
  };

  return (
    <div className="flex flex-col gap-2.5">
      <FilterRow
        label="Impact"
        options={SEVERITY_OPTIONS}
        labels={SEVERITY_LABELS}
        active={initialQuery.severity}
        countFor={(severity) => facets.severity[severity]}
        onToggle={makeOnToggle("severity", initialQuery.severity)}
        disabled={isPending}
      />
      <FilterRow
        label="Ecosystem"
        options={ECOSYSTEM_OPTIONS}
        labels={ECOSYSTEM_LABELS}
        active={initialQuery.ecosystem}
        countFor={(ecosystem) => facets.ecosystem[ecosystem]}
        onToggle={makeOnToggle("ecosystem", initialQuery.ecosystem)}
        disabled={isPending}
      />
      <FilterRow
        label="Effort"
        options={EFFORT_OPTIONS}
        labels={EFFORT_LABELS}
        active={initialQuery.effort}
        countFor={(effort) => facets.effort[effort]}
        onToggle={makeOnToggle("effort", initialQuery.effort)}
        disabled={isPending}
      />
      <FilterRow
        label="Type"
        options={MISSION_TYPE_OPTIONS}
        labels={MISSION_TYPE_LABELS}
        active={initialQuery.missionType}
        countFor={(type) => facets.missionType[type]}
        onToggle={makeOnToggle("missionType", initialQuery.missionType)}
        disabled={isPending}
      />
    </div>
  );
}

export { EmptyFilterState };
