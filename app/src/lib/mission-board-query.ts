import type { Ecosystem, EffortLabel, Severity } from "@deptend/core/db/schema.js";
import { ECOSYSTEM_OPTIONS, EFFORT_OPTIONS, SEVERITY_OPTIONS } from "./mission-filter-options";

// Deliberately NOT "use client" — page.tsx (a Server Component) calls
// parseMissionBoardQuery() directly, and mission-board.tsx (a Client
// Component) calls it too. A function exported from a "use client" module
// can only be rendered as a Component or passed as a prop; it can't be
// invoked as a plain function from server code. Keeping this parsing logic
// in its own client-agnostic module lets both sides share one source of
// truth without crossing that boundary.

export type SortMode = "priority" | "quick-wins" | "newest";
export const SORT_MODES: readonly SortMode[] = ["priority", "quick-wins", "newest"];

/** Display text for each sort mode — shared by both mission boards' selects. */
export const SORT_LABELS: Record<SortMode, string> = {
  priority: "Highest impact first",
  "quick-wins": "Quickest wins first",
  newest: "Newest advisory first",
};

/** Parsed, validated shape of everything the mission board keeps in the URL. */
export interface MissionBoardQuery {
  q: string;
  severity: ReadonlySet<Severity>;
  ecosystem: ReadonlySet<Ecosystem>;
  effort: ReadonlySet<EffortLabel>;
  sort: SortMode;
  group: boolean;
  /**
   * 1-based page number. Only meaningful on boards that paginate
   * server-side (/missions, ADR 0031); the per-repo board ignores it.
   */
  page: number;
}

/**
 * Loose shape for building board URLs from client state — every field
 * optional and defaulted, so callers can override one axis without
 * reconstructing the rest (used by the paginated board's chips/sort/
 * pagination links).
 */
export interface MissionBoardQueryState {
  q?: string | undefined;
  severity?: ReadonlySet<Severity> | undefined;
  ecosystem?: ReadonlySet<Ecosystem> | undefined;
  effort?: ReadonlySet<EffortLabel> | undefined;
  sort?: SortMode | undefined;
  group?: boolean | undefined;
  page?: number | undefined;
}

function parsePageParam(value: string | null | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
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
  page?: string | undefined;
}): MissionBoardQuery {
  return {
    q: params.q ?? "",
    severity: parseSetParam(params.severity ?? null, SEVERITY_OPTIONS),
    ecosystem: parseSetParam(params.ecosystem ?? null, ECOSYSTEM_OPTIONS),
    effort: parseSetParam(params.effort ?? null, EFFORT_OPTIONS),
    sort: parseSortParam(params.sort ?? null),
    group: params.group === "1",
    page: parsePageParam(params.page),
  };
}

/**
 * Inverse of parseMissionBoardQuery: serializes board state into a query
 * string, omitting every defaulted axis (empty sets, "priority" sort,
 * grouping off, page 1) so URLs stay minimal and stable. Shared by the
 * paginated board's link-based filters — one builder, one canonical URL
 * shape, whether the caller navigates via <Link> or router.replace.
 */
export function serializeMissionBoardQuery(state: MissionBoardQueryState): string {
  const params = new URLSearchParams();
  const q = state.q?.trim() ?? "";
  if (q !== "") {
    params.set("q", q);
  }
  if (state.severity !== undefined && state.severity.size > 0) {
    params.set("severity", Array.from(state.severity).join(","));
  }
  if (state.ecosystem !== undefined && state.ecosystem.size > 0) {
    params.set("ecosystem", Array.from(state.ecosystem).join(","));
  }
  if (state.effort !== undefined && state.effort.size > 0) {
    params.set("effort", Array.from(state.effort).join(","));
  }
  if (state.sort !== undefined && state.sort !== "priority") {
    params.set("sort", state.sort);
  }
  if (state.group === true) {
    params.set("group", "1");
  }
  if (state.page !== undefined && state.page > 1) {
    params.set("page", String(state.page));
  }
  return params.toString();
}

export function buildMissionBoardHref(basePath: string, state: MissionBoardQueryState): string {
  const query = serializeMissionBoardQuery(state);
  return query === "" ? basePath : `${basePath}?${query}`;
}

/** Copy of `set` with `value` added/removed — the chip-toggle primitive. */
export function toggledSet<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}
