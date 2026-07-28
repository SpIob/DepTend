import type { Ecosystem, EffortLabel, Severity } from "@deptend/core/db/schema.js";

// Deliberately NOT "use client" — page.tsx (a Server Component) calls
// parseMissionBoardQuery() directly, and mission-board.tsx (a Client
// Component) calls it too. A function exported from a "use client" module
// can only be rendered as a Component or passed as a prop; it can't be
// invoked as a plain function from server code. Keeping this parsing logic
// in its own client-agnostic module lets both sides share one source of
// truth without crossing that boundary.

export const SEVERITY_VALUES: readonly Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "unknown",
];
export const ECOSYSTEM_VALUES: readonly Ecosystem[] = ["npm", "pypi", "go"];
export const EFFORT_VALUES: readonly EffortLabel[] = ["trivial", "low", "medium", "high"];

export type SortMode = "priority" | "quick-wins" | "newest";
export const SORT_MODES: readonly SortMode[] = ["priority", "quick-wins", "newest"];

/** Parsed, validated shape of everything the mission board keeps in the URL. */
export interface MissionBoardQuery {
  q: string;
  severity: ReadonlySet<Severity>;
  ecosystem: ReadonlySet<Ecosystem>;
  effort: ReadonlySet<EffortLabel>;
  sort: SortMode;
  group: boolean;
}

function parseSetParam<T extends string>(
  value: string | null,
  allowed: readonly T[],
): ReadonlySet<T> {
  if (value === null || value === "") {
    return new Set();
  }
  const allowedSet: ReadonlySet<string> = new Set(allowed);
  return new Set(value.split(",").filter((v): v is T => allowedSet.has(v)));
}

export function parseSortParam(value: string | null): SortMode {
  return SORT_MODES.find((mode) => mode === value) ?? "priority";
}

/**
 * Reads the same query shape whether it came from Next's server-side
 * `searchParams` (page.tsx, on first load) or this component's own
 * client-side state serialization — one parser, one source of truth.
 */
export function parseMissionBoardQuery(params: {
  q?: string | undefined;
  severity?: string | undefined;
  ecosystem?: string | undefined;
  effort?: string | undefined;
  sort?: string | undefined;
  group?: string | undefined;
}): MissionBoardQuery {
  return {
    q: params.q ?? "",
    severity: parseSetParam(params.severity ?? null, SEVERITY_VALUES),
    ecosystem: parseSetParam(params.ecosystem ?? null, ECOSYSTEM_VALUES),
    effort: parseSetParam(params.effort ?? null, EFFORT_VALUES),
    sort: parseSortParam(params.sort ?? null),
    group: params.group === "1",
  };
}
