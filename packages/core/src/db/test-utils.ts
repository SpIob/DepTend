/**
 * Shared test utilities for db/ query tests
 *
 * Extracts the fake-transport infrastructure from queries.test.ts so
 * board-queries.test.ts and directory-queries.test.ts can share it
 * without duplication.
 */

import { vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import type { PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";
import {
  dependencies,
  missions,
  missionScores,
  notificationSubscriptions,
  repos,
} from "./schema.js";
import type { ReadonlyDb } from "./queries.js";
import { createReadonlyDb } from "./queries.js";

export { createReadonlyDb };

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

export interface CapturedCall {
  sql: string;
  params: unknown[];
}

/** Routes one captured statement to canned rows, keyed by query shape. */
export type RowRouter = (sql: string) => unknown[][];

export function makeDb(route: RowRouter): { db: ReadonlyDb; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const client = vi.fn((text: string, params: unknown[]): Promise<{ rows: unknown[][] }> => {
    calls.push({ sql: text, params });
    return Promise.resolve({ rows: route(text) });
  });
  const db = drizzle(client as never, { schema }) as unknown as ReadonlyDb;
  return { db, calls };
}

/** Expands a fixture object (TS property names) into driver-shape positional row order. */
export function flatten(table: PgTable, values: Record<string, unknown>): unknown[] {
  return Object.entries(getTableColumns(table)).map(([key]) => values[key] ?? null);
}

export function bySql(calls: readonly CapturedCall[], pattern: RegExp): CapturedCall {
  const match = calls.find((call) => pattern.test(call.sql));
  if (match === undefined) {
    throw new Error(
      `No captured call matched ${String(pattern)} in:\n${calls.map((c) => c.sql).join("\n---\n")}`,
    );
  }
  return match;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

export const NOW = new Date("2026-08-01T00:00:00.000Z");

export const MISSION_VALUES: Record<string, unknown> = {
  id: "m-1",
  repoId: "r-1",
  title: "Update lodash to fix a high vulnerability",
  description: "description",
  actionHint: null,
  missionType: "vulnerability_fix",
  status: "open",
  advisoryId: "a-1",
  dependencyId: "d-1",
  claimedBy: null,
  claimedAt: null,
  resolvedAt: null,
  dismissedAt: null,
  dismissReason: null,
  createdAt: NOW,
  updatedAt: NOW,
};

export const SCORE_VALUES: Record<string, unknown> = {
  id: "s-1",
  missionId: "m-1",
  impactScore: 7.5,
  ecosystemValueScore: 5,
  compositeScore: 6.5,
  effortLabel: "low",
  impactInputs: {},
  ecosystemValueInputs: {},
  effortInputs: {},
  confidence: "low",
  confidenceNotes: null,
  confidenceFlags: {},
  scoringVersion: "0.1.0",
  createdAt: NOW,
  updatedAt: NOW,
};

export const ADVISORY_VALUES: Record<string, unknown> = {
  id: "a-1",
  osvId: "GHSA-xxxx-yyyy-zzzz",
  source: "osv",
  ecosystem: "npm",
  packageName: "lodash",
  severity: "high",
  cvssScore: 7.5,
  summary: "summary",
  details: null,
  affectedVersions: [],
  fixedVersion: "4.17.21",
  publishedAt: NOW,
  modifiedAt: NOW,
  rawData: {},
  createdAt: NOW,
  updatedAt: NOW,
};

export const DEPENDENCY_VALUES: Record<string, unknown> = {
  id: "d-1",
  repoId: "r-1",
  ecosystem: "npm",
  packageName: "lodash",
  versionSpec: "^4.17.20",
  resolvedVersion: null,
  depType: "production",
  latestVersion: null,
  isDeprecated: false,
  deprecationNote: null,
  createdAt: NOW,
  updatedAt: NOW,
};

export const REPO_VALUES: Record<string, unknown> = {
  id: "r-1",
  githubUrl: "https://github.com/octo/repo",
  owner: "octo",
  name: "repo",
  defaultBranch: "main",
  description: null,
  stars: 10,
  openIssuesCount: 2,
  topics: [],
  homepageUrl: null,
  ingestionStatus: "complete",
  lastIngestedAt: NOW,
  ingestionError: null,
  submittedBy: null,
  orgId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

/** The advisory segment of a joined row, positional order matching queries.ts's advisoryListSelection. */
export function advisoryListColumns(): unknown[] {
  return [
    ADVISORY_VALUES.id,
    ADVISORY_VALUES.osvId,
    ADVISORY_VALUES.source,
    ADVISORY_VALUES.ecosystem,
    ADVISORY_VALUES.severity,
    ADVISORY_VALUES.fixedVersion,
    ADVISORY_VALUES.publishedAt,
  ];
}

export const ADVISORY_SUMMARY_EXPECTED = {
  id: ADVISORY_VALUES.id,
  osvId: ADVISORY_VALUES.osvId,
  source: ADVISORY_VALUES.source,
  ecosystem: ADVISORY_VALUES.ecosystem,
  severity: ADVISORY_VALUES.severity,
  fixedVersion: ADVISORY_VALUES.fixedVersion,
  publishedAt: ADVISORY_VALUES.publishedAt,
};

/** One fully-populated five-table join row, in driver positional order. */
export function joinedRow(): unknown[] {
  return [
    ...flatten(missions, MISSION_VALUES),
    ...flatten(missionScores, SCORE_VALUES),
    ...advisoryListColumns(),
    ...flatten(dependencies, DEPENDENCY_VALUES),
    ...flatten(repos, REPO_VALUES),
  ];
}

export const EMPTY_FILTERS: import("./queries.js").BoardFilters = {
  q: "",
  severities: [],
  ecosystems: [],
  efforts: [],
  missionTypes: [],
  sort: "priority",
};

/** One row for the merged tally statement: [total, then one count column per known severity, ecosystem, and effort enum value]. */
export function tallyRow(overrides: Partial<Record<string, number>> = {}): unknown[] {
  const values: Record<string, number> = {
    total: 0,
    severity_critical: 0,
    severity_high: 0,
    severity_medium: 0,
    severity_low: 0,
    severity_unknown: 0,
    ecosystem_npm: 0,
    ecosystem_pypi: 0,
    ecosystem_go: 0,
    effort_trivial: 0,
    effort_low: 0,
    effort_medium: 0,
    effort_high: 0,
    ...overrides,
  };
  return Object.values(values);
}

/** Default routing for the board query's two parallel statements. */
export function boardRouter(overrides: Partial<Record<"page" | "tally", unknown[][]>>): RowRouter {
  return (sql: string): unknown[][] => {
    if (sql.includes("limit ")) return overrides.page ?? [joinedRow()];
    if (sql.includes("count(*)")) return overrides.tally ?? [tallyRow({ total: 3 })];
    return [];
  };
}

// The subscriptions table has a text[] event_types column Drizzle's
// PgArray column deserializer walks, so the row fixture must carry the
// array in driver shape — the other fixtures use plain string columns
// and don't trip the deserializer.
export const SUB_ROW = flatten(notificationSubscriptions, {
  id: "s-1",
  userLogin: "octocat",
  repoId: "r-2",
  eventTypes: ["new_mission", "claimed", "resolved"],
  githubIssueNumber: null,
  createdAt: NOW,
});

// getSubscribedRepoIds only selects repoId, so this is the shape for that query.
export const SUB_ROW_REPO_ID = [["r-2"]];
