/**
 * Shared server-side logic for mission board pages.
 *
 * Both /missions and /repo/[owner]/[name] parse search params, validate
 * them, and build BoardFilters. This module consolidates that logic to
 * avoid duplication and ensure consistent behavior.
 */

import { redirect } from "next/navigation";
import {
  buildMissionBoardHref,
  clampPageNumber,
  isCanonicalMissionBoardQuery,
  parseMissionBoardQuery,
  type MissionBoardQuery,
} from "./mission-board-query";
import { firstSearchParamValue } from "./search-params";
import type { BoardFilters } from "@deptend/core/db/queries.js";

/**
 * Parses raw search params into a validated MissionBoardQuery.
 * If the URL is non-canonical (contains values that parse to defaults),
 * redirects to the canonical URL.
 */
export async function parseAndValidateBoardQuery(
  searchParams: Promise<Record<string, string | string[] | undefined>>,
  basePath: string,
): Promise<MissionBoardQuery> {
  const rawParams = await searchParams;
  const query = parseMissionBoardQuery({
    q: firstSearchParamValue(rawParams.q),
    severity: firstSearchParamValue(rawParams.severity),
    ecosystem: firstSearchParamValue(rawParams.ecosystem),
    effort: firstSearchParamValue(rawParams.effort),
    missionType: firstSearchParamValue(rawParams.missionType),
    sort: firstSearchParamValue(rawParams.sort),
    group: firstSearchParamValue(rawParams.group),
    page: firstSearchParamValue(rawParams.page),
  });

  // Canonicalize the URL when any value was coerced to a default by
  // parseMissionBoardQuery (unknown sort, unrecognized filter values,
  // group=0, page=0, etc.) — otherwise the dropdown's actual state and
  // the URL disagree, and any subsequent chip click re-emits the bad
  // value as if it were legitimate.
  if (
    !isCanonicalMissionBoardQuery({
      q: firstSearchParamValue(rawParams.q),
      severity: firstSearchParamValue(rawParams.severity),
      ecosystem: firstSearchParamValue(rawParams.ecosystem),
      effort: firstSearchParamValue(rawParams.effort),
      missionType: firstSearchParamValue(rawParams.missionType),
      sort: firstSearchParamValue(rawParams.sort),
      group: firstSearchParamValue(rawParams.group),
      page: firstSearchParamValue(rawParams.page),
    })
  ) {
    redirect(
      buildMissionBoardHref(basePath, {
        q: query.q,
        severity: query.severity,
        ecosystem: query.ecosystem,
        effort: query.effort,
        missionType: query.missionType,
        sort: query.sort,
        group: query.group,
        page: query.page,
      }),
    );
  }

  return query;
}

/**
 * Builds BoardFilters from a MissionBoardQuery for use in database queries.
 */
export function buildBoardFilters(query: MissionBoardQuery): BoardFilters {
  return {
    q: query.q,
    severities: Array.from(query.severity),
    ecosystems: Array.from(query.ecosystem),
    efforts: Array.from(query.effort),
    missionTypes: Array.from(query.missionType),
    sort: query.sort,
  };
}

/**
 * Computes the effective page number, clamped to valid range.
 */
export function getEffectivePage(page: number, total: number, pageSize: number): number {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return clampPageNumber(page, pageCount);
}

/**
 * Checks if any filters are active (for empty state logic).
 */
export function hasActiveFilters(query: MissionBoardQuery): boolean {
  return (
    query.severity.size > 0 ||
    query.ecosystem.size > 0 ||
    query.effort.size > 0 ||
    query.missionType.size > 0 ||
    query.q.trim() !== ""
  );
}

/**
 * Builds the base path for a repo's mission board.
 */
export function buildRepoBoardBasePath(owner: string, name: string): string {
  return buildMissionBoardHref(`/repo/${owner}/${name}`, {});
}
