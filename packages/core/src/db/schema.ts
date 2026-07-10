// =============================================================================
// deptend.dev — Drizzle ORM Schema
// Source of truth for all database types and structure.
// Converted from schema.sql v0.1.0 — Phase 0 Foundation.
//
// Migration files are generated from this file via:
//   pnpm drizzle-kit generate
// and applied via:
//   pnpm drizzle-kit migrate
// =============================================================================

import {
  boolean,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  integer,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ConfidenceFlags,
  EcosystemValueInputs,
  EffortInputs,
  ImpactInputs,
  OsvVersionRange,
} from "./json-types.js";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ingestionStatusEnum = pgEnum("ingestion_status", [
  "pending",
  "running",
  "complete",
  "failed",
]);

export const depTypeEnum = pgEnum("dep_type", ["production", "development", "peer", "optional"]);

export const ecosystemEnum = pgEnum("ecosystem", [
  "npm",
  // 'pypi' added in Phase 6+
]);

export const advisorySourceEnum = pgEnum("advisory_source", ["osv", "ghsa"]);

export const severityEnum = pgEnum("severity", ["critical", "high", "medium", "low", "unknown"]);

export const missionTypeEnum = pgEnum("mission_type", [
  "vulnerability_fix",
  "dep_update",
  "maintenance",
  "license_issue",
]);

export const missionStatusEnum = pgEnum("mission_status", [
  "open",
  "claimed",
  "resolved",
  "dismissed",
]);

export const effortLabelEnum = pgEnum("effort_label", ["trivial", "low", "medium", "high"]);

export const scoreConfidenceEnum = pgEnum("score_confidence", ["high", "medium", "low"]);

// ---------------------------------------------------------------------------
// repos
// ---------------------------------------------------------------------------

export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    githubUrl: text("github_url").notNull().unique(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),

    description: text("description"),
    stars: integer("stars").notNull().default(0),
    openIssuesCount: integer("open_issues_count").notNull().default(0),
    topics: text("topics").array().notNull().default([]),
    homepageUrl: text("homepage_url"),

    ingestionStatus: ingestionStatusEnum("ingestion_status").notNull().default("pending"),
    lastIngestedAt: timestamp("last_ingested_at", { withTimezone: true }),
    ingestionError: text("ingestion_error"),

    submittedBy: text("submitted_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("repos_owner_name_unique").on(table.owner, table.name),
    index("idx_repos_ingestion_status").on(table.ingestionStatus),
    index("idx_repos_last_ingested_at").on(table.lastIngestedAt),
  ],
);

// ---------------------------------------------------------------------------
// dependencies
// ---------------------------------------------------------------------------

export const dependencies = pgTable(
  "dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    ecosystem: ecosystemEnum("ecosystem").notNull().default("npm"),
    packageName: text("package_name").notNull(),
    versionSpec: text("version_spec").notNull(),

    resolvedVersion: text("resolved_version"),

    depType: depTypeEnum("dep_type").notNull(),
    latestVersion: text("latest_version"),

    isDeprecated: boolean("is_deprecated").notNull().default(false),
    deprecationNote: text("deprecation_note"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("dependencies_repo_package_deptype_unique").on(
      table.repoId,
      table.packageName,
      table.depType,
    ),
    index("idx_dependencies_repo_id").on(table.repoId),
    index("idx_dependencies_package_name").on(table.packageName),
    index("idx_dependencies_ecosystem").on(table.ecosystem),
  ],
);

// ---------------------------------------------------------------------------
// advisories
// ---------------------------------------------------------------------------

export const advisories = pgTable(
  "advisories",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    osvId: text("osv_id").notNull().unique(),
    source: advisorySourceEnum("source").notNull(),
    ecosystem: ecosystemEnum("ecosystem").notNull().default("npm"),
    packageName: text("package_name").notNull(),

    severity: severityEnum("severity").notNull().default("unknown"),
    cvssScore: numeric("cvss_score", { precision: 4, scale: 1, mode: "number" }),

    summary: text("summary").notNull(),
    details: text("details"),

    affectedVersions: jsonb("affected_versions").$type<OsvVersionRange[]>().notNull().default([]),
    fixedVersion: text("fixed_version"),

    publishedAt: timestamp("published_at", { withTimezone: true }),
    modifiedAt: timestamp("modified_at", { withTimezone: true }),

    // Verbatim OSV snapshot — deliberately left as an untyped blob rather
    // than `$type<Record<string, unknown>>()`. It's genuinely unstructured
    // (whatever OSV returned that day) and a concrete interface like
    // OsvVulnerability isn't structurally assignable to an index-signature
    // type without an escape hatch, which would just push a workaround into
    // every write site instead of removing one. See ADR 0011.
    rawData: jsonb("raw_data").notNull().default({}),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_advisories_package_name").on(table.packageName),
    index("idx_advisories_ecosystem").on(table.ecosystem),
    index("idx_advisories_severity").on(table.severity),
    index("idx_advisories_modified_at").on(table.modifiedAt),
  ],
);

// ---------------------------------------------------------------------------
// dependency_advisories
// ---------------------------------------------------------------------------

export const dependencyAdvisories = pgTable(
  "dependency_advisories",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    dependencyId: uuid("dependency_id")
      .notNull()
      .references(() => dependencies.id, { onDelete: "cascade" }),
    advisoryId: uuid("advisory_id")
      .notNull()
      .references(() => advisories.id, { onDelete: "cascade" }),

    isAffected: boolean("is_affected").notNull(),
    matchMethod: text("match_method").notNull().default("version_spec"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("dependency_advisories_unique").on(table.dependencyId, table.advisoryId),
    index("idx_dep_advisories_dependency_id").on(table.dependencyId),
    index("idx_dep_advisories_advisory_id").on(table.advisoryId),
    index("idx_dep_advisories_is_affected").on(table.isAffected),
  ],
);

// ---------------------------------------------------------------------------
// missions
// ---------------------------------------------------------------------------

export const missions = pgTable(
  "missions",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),

    title: text("title").notNull(),
    description: text("description").notNull(),
    actionHint: text("action_hint"),

    missionType: missionTypeEnum("mission_type").notNull(),
    status: missionStatusEnum("status").notNull().default("open"),

    advisoryId: uuid("advisory_id").references(() => advisories.id, { onDelete: "set null" }),
    dependencyId: uuid("dependency_id").references(() => dependencies.id, { onDelete: "set null" }),

    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissReason: text("dismiss_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_missions_repo_id").on(table.repoId),
    index("idx_missions_status").on(table.status),
    index("idx_missions_mission_type").on(table.missionType),
    index("idx_missions_advisory_id").on(table.advisoryId),
  ],
);

// ---------------------------------------------------------------------------
// mission_scores
// ---------------------------------------------------------------------------

export const missionScores = pgTable(
  "mission_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    missionId: uuid("mission_id")
      .notNull()
      .unique()
      .references(() => missions.id, { onDelete: "cascade" }),

    impactScore: numeric("impact_score", { precision: 4, scale: 1, mode: "number" }).notNull(),
    ecosystemValueScore: numeric("ecosystem_value_score", {
      precision: 4,
      scale: 1,
      mode: "number",
    }).notNull(),
    compositeScore: numeric("composite_score", {
      precision: 4,
      scale: 1,
      mode: "number",
    }).notNull(),
    effortLabel: effortLabelEnum("effort_label").notNull(),

    // Raw scoring inputs stored for full auditability
    impactInputs: jsonb("impact_inputs").$type<ImpactInputs>().notNull().default({
      cvss_score: null,
      severity: "unknown",
      is_transitive: false,
      dep_type: "production",
      days_since_advisory: null,
    }),
    ecosystemValueInputs: jsonb("ecosystem_value_inputs")
      .$type<EcosystemValueInputs>()
      .notNull()
      .default({ repo_stars: 0, open_issues_count: 0, downstream_dependents: null }),
    effortInputs: jsonb("effort_inputs").$type<EffortInputs>().notNull().default({
      semver_bump: "unknown",
      has_migration_guide: false,
      breaking_change_signals: [],
    }),

    confidence: scoreConfidenceEnum("confidence").notNull(),
    confidenceNotes: text("confidence_notes").array(),
    confidenceFlags: jsonb("confidence_flags").$type<ConfidenceFlags>().notNull().default({}),

    scoringVersion: text("scoring_version").notNull().default("0.1.0"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_mission_scores_mission_id").on(table.missionId),
    index("idx_mission_scores_composite_score").on(table.compositeScore),
    index("idx_mission_scores_confidence").on(table.confidence),
  ],
);

// ---------------------------------------------------------------------------
// ingestion_runs
// ---------------------------------------------------------------------------

export const ingestionRuns = pgTable(
  "ingestion_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),

    triggeredBy: text("triggered_by").notNull(),
    // 'cron' | 'manual' | 'submit'

    status: ingestionStatusEnum("status").notNull().default("running"),

    dependenciesFound: integer("dependencies_found").notNull().default(0),
    advisoriesFetched: integer("advisories_fetched").notNull().default(0),
    missionsCreated: integer("missions_created").notNull().default(0),
    missionsUpdated: integer("missions_updated").notNull().default(0),

    errorMessage: text("error_message"),
    errorStack: text("error_stack"),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_ingestion_runs_repo_id").on(table.repoId),
    index("idx_ingestion_runs_status").on(table.status),
    index("idx_ingestion_runs_started_at").on(table.startedAt),
  ],
);

// ---------------------------------------------------------------------------
// Enum value types
// ---------------------------------------------------------------------------
// Derived from the pgEnum objects above so enum unions never need a
// hand-duplicated equivalent elsewhere (ADR 0011).

export type IngestionStatus = (typeof ingestionStatusEnum.enumValues)[number];
export type DepType = (typeof depTypeEnum.enumValues)[number];
export type Ecosystem = (typeof ecosystemEnum.enumValues)[number];
export type AdvisorySource = (typeof advisorySourceEnum.enumValues)[number];
export type Severity = (typeof severityEnum.enumValues)[number];
export type MissionType = (typeof missionTypeEnum.enumValues)[number];
export type MissionStatus = (typeof missionStatusEnum.enumValues)[number];
export type EffortLabel = (typeof effortLabelEnum.enumValues)[number];
export type ScoreConfidence = (typeof scoreConfidenceEnum.enumValues)[number];

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------
// Use these throughout /app and /packages/core instead of hand-written interfaces.

export type Repo = typeof repos.$inferSelect;
export type NewRepo = typeof repos.$inferInsert;

export type Dependency = typeof dependencies.$inferSelect;
export type NewDependency = typeof dependencies.$inferInsert;

export type Advisory = typeof advisories.$inferSelect;
export type NewAdvisory = typeof advisories.$inferInsert;

export type DependencyAdvisory = typeof dependencyAdvisories.$inferSelect;
export type NewDependencyAdvisory = typeof dependencyAdvisories.$inferInsert;

export type Mission = typeof missions.$inferSelect;
export type NewMission = typeof missions.$inferInsert;

export type MissionScore = typeof missionScores.$inferSelect;
export type NewMissionScore = typeof missionScores.$inferInsert;

export type IngestionRun = typeof ingestionRuns.$inferSelect;
export type NewIngestionRun = typeof ingestionRuns.$inferInsert;
