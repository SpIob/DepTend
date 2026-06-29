-- =============================================================================
-- deptend.dev — Database Schema
-- PostgreSQL (Neon free tier)
-- Version: 0.1.0
-- Phase: 0 — Foundation
--
-- Entities:
--   repos              — tracked GitHub repositories
--   dependencies       — packages declared in each repo's package.json
--   advisories         — vulnerability records from OSV / GHSA
--   dependency_advisories — which dependencies are affected by which advisories
--   missions           — ranked maintenance work items surfaced to users
--   mission_scores     — scoring breakdown (impact, effort, ecosystem value)
--   ingestion_runs     — audit log of every ingestion job
--
-- Conventions:
--   - All primary keys are UUIDs (gen_random_uuid()).
--   - All timestamps are TIMESTAMPTZ stored in UTC.
--   - JSONB columns store raw source payloads for auditability and replay.
--   - Enum types are defined as PostgreSQL TYPE objects; add values via
--     ALTER TYPE ... ADD VALUE (never remove or reorder existing values).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- provides gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------

CREATE TYPE ingestion_status AS ENUM (
  'pending',
  'running',
  'complete',
  'failed'
);

CREATE TYPE dep_type AS ENUM (
  'production',
  'development',
  'peer',
  'optional'
);

CREATE TYPE ecosystem AS ENUM (
  'npm'
  -- 'pypi' added in Phase 6+
);

CREATE TYPE advisory_source AS ENUM (
  'osv',
  'ghsa'
);

CREATE TYPE severity AS ENUM (
  'critical',
  'high',
  'medium',
  'low',
  'unknown'
);

CREATE TYPE mission_type AS ENUM (
  'vulnerability_fix',   -- a known CVE/advisory needs patching
  'dep_update',          -- outdated dependency, no known CVE
  'maintenance',         -- general upkeep (deprecated package, zero-maintenance upstream)
  'license_issue'        -- incompatible or missing license
);

CREATE TYPE mission_status AS ENUM (
  'open',
  'claimed',
  'resolved',
  'dismissed'
);

CREATE TYPE effort_label AS ENUM (
  'trivial',   -- one-line version bump, no API changes
  'low',       -- small change, well-documented migration
  'medium',    -- some breaking changes; may require testing
  'high'       -- significant breaking changes, API redesign required
);

CREATE TYPE score_confidence AS ENUM (
  'high',    -- lock file present, full metadata available
  'medium',  -- package.json only, some metadata gaps
  'low'      -- significant data missing (no lock file AND sparse registry data)
);

-- ---------------------------------------------------------------------------
-- repos
-- ---------------------------------------------------------------------------
-- A repo submitted by a user for analysis.
-- MVP hard cap: 3 rows (enforced at application layer, not DB constraint).
-- ---------------------------------------------------------------------------
CREATE TABLE repos (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- GitHub identity
  github_url        TEXT        NOT NULL UNIQUE,  -- https://github.com/{owner}/{name}
  owner             TEXT        NOT NULL,
  name              TEXT        NOT NULL,
  default_branch    TEXT        NOT NULL DEFAULT 'main',

  -- Metadata snapshot (refreshed each ingestion run)
  description       TEXT,
  stars             INTEGER     NOT NULL DEFAULT 0,
  open_issues_count INTEGER     NOT NULL DEFAULT 0,
  topics            TEXT[]      NOT NULL DEFAULT '{}',
  homepage_url      TEXT,

  -- Ingestion bookkeeping
  ingestion_status  ingestion_status NOT NULL DEFAULT 'pending',
  last_ingested_at  TIMESTAMPTZ,
  ingestion_error   TEXT,           -- last error message, if status = 'failed'

  -- Submitter (GitHub username from OAuth; NULL for CLI-submitted repos)
  submitted_by      TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT repos_owner_name_unique UNIQUE (owner, name)
);

CREATE INDEX idx_repos_ingestion_status ON repos (ingestion_status);
CREATE INDEX idx_repos_last_ingested_at ON repos (last_ingested_at);

-- ---------------------------------------------------------------------------
-- dependencies
-- ---------------------------------------------------------------------------
-- A single package entry parsed from a repo's package.json.
-- One row per (repo, package_name, dep_type) combination.
-- If a lock file is present, resolved_version is populated; otherwise NULL.
-- ---------------------------------------------------------------------------
CREATE TABLE dependencies (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  repo_id           UUID        NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  ecosystem         ecosystem   NOT NULL DEFAULT 'npm',
  package_name      TEXT        NOT NULL,

  -- Declared range from package.json, e.g. "^18.2.0"
  version_spec      TEXT        NOT NULL,

  -- Pinned version from lock file; NULL when lock file absent (Phase 1 baseline)
  resolved_version  TEXT,

  dep_type          dep_type    NOT NULL,

  -- Latest version at time of ingestion (fetched from registry)
  latest_version    TEXT,

  -- Whether resolved_version (or the lower bound of version_spec) is deprecated
  is_deprecated     BOOLEAN     NOT NULL DEFAULT FALSE,
  deprecation_note  TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT dependencies_repo_package_deptype_unique
    UNIQUE (repo_id, package_name, dep_type)
);

CREATE INDEX idx_dependencies_repo_id     ON dependencies (repo_id);
CREATE INDEX idx_dependencies_package_name ON dependencies (package_name);
CREATE INDEX idx_dependencies_ecosystem   ON dependencies (ecosystem);

-- ---------------------------------------------------------------------------
-- advisories
-- ---------------------------------------------------------------------------
-- Vulnerability / advisory records fetched from OSV and GHSA.
-- Keyed by osv_id (e.g. "GHSA-abc1-abc2-abc3" or "RUSTSEC-…").
-- One row per advisory; shared across all repos that use the affected package.
-- ---------------------------------------------------------------------------
CREATE TABLE advisories (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Canonical identifier from the source database
  osv_id            TEXT        NOT NULL UNIQUE,

  source            advisory_source NOT NULL,
  ecosystem         ecosystem   NOT NULL DEFAULT 'npm',
  package_name      TEXT        NOT NULL,

  severity          severity    NOT NULL DEFAULT 'unknown',

  -- CVSS score when available (0.0–10.0); NULL when not provided
  cvss_score        NUMERIC(4,1) CHECK (cvss_score IS NULL OR (cvss_score >= 0 AND cvss_score <= 10)),

  -- Human-readable title and detail
  summary           TEXT        NOT NULL,
  details           TEXT,

  -- Affected version range as JSONB (OSV "ranges" array, stored verbatim)
  affected_versions JSONB       NOT NULL DEFAULT '[]',

  -- First fixed version, if patched upstream
  fixed_version     TEXT,

  -- Advisory lifecycle timestamps from the source
  published_at      TIMESTAMPTZ,
  modified_at       TIMESTAMPTZ,

  -- Full source record for auditability and replay without re-fetching
  raw_data          JSONB       NOT NULL DEFAULT '{}',

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_advisories_package_name  ON advisories (package_name);
CREATE INDEX idx_advisories_ecosystem     ON advisories (ecosystem);
CREATE INDEX idx_advisories_severity      ON advisories (severity);
CREATE INDEX idx_advisories_modified_at   ON advisories (modified_at);

-- ---------------------------------------------------------------------------
-- dependency_advisories
-- ---------------------------------------------------------------------------
-- Junction table: which dependencies are affected by which advisories.
-- Populated during ingestion after version range evaluation.
-- ---------------------------------------------------------------------------
CREATE TABLE dependency_advisories (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  dependency_id   UUID        NOT NULL REFERENCES dependencies (id) ON DELETE CASCADE,
  advisory_id     UUID        NOT NULL REFERENCES advisories  (id) ON DELETE CASCADE,

  -- TRUE  = the installed/declared version falls within an affected range
  -- FALSE = version range evaluated; not affected (advisory matched by name but version is safe)
  is_affected     BOOLEAN     NOT NULL,

  -- How the version match was determined
  match_method    TEXT        NOT NULL DEFAULT 'version_spec',
  -- 'version_spec'     — matched against declared range in package.json
  -- 'resolved_version' — matched against pinned version from lock file

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT dependency_advisories_unique UNIQUE (dependency_id, advisory_id)
);

CREATE INDEX idx_dep_advisories_dependency_id ON dependency_advisories (dependency_id);
CREATE INDEX idx_dep_advisories_advisory_id   ON dependency_advisories (advisory_id);
CREATE INDEX idx_dep_advisories_is_affected   ON dependency_advisories (is_affected);

-- ---------------------------------------------------------------------------
-- missions
-- ---------------------------------------------------------------------------
-- A maintenance work item surfaced to users on the dashboard.
-- One mission per actionable item per repo (e.g. "upgrade lodash to fix CVE-…").
-- ---------------------------------------------------------------------------
CREATE TABLE missions (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  repo_id         UUID          NOT NULL REFERENCES repos (id) ON DELETE CASCADE,

  -- Human-facing content (generated during scoring, stored for transparency)
  title           TEXT          NOT NULL,
  description     TEXT          NOT NULL, -- plain-language explanation of what to do and why
  action_hint     TEXT,                   -- e.g. "Run: pnpm update lodash"

  mission_type    mission_type  NOT NULL,
  status          mission_status NOT NULL DEFAULT 'open',

  -- Optional: link back to the advisory or dependency that generated this mission
  advisory_id     UUID          REFERENCES advisories   (id) ON DELETE SET NULL,
  dependency_id   UUID          REFERENCES dependencies (id) ON DELETE SET NULL,

  -- Claim tracking (Phase 5 — Public Rescue Board)
  claimed_by      TEXT,         -- GitHub username
  claimed_at      TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  dismissed_at    TIMESTAMPTZ,
  dismiss_reason  TEXT,

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_missions_repo_id      ON missions (repo_id);
CREATE INDEX idx_missions_status       ON missions (status);
CREATE INDEX idx_missions_mission_type ON missions (mission_type);
CREATE INDEX idx_missions_advisory_id  ON missions (advisory_id);

-- ---------------------------------------------------------------------------
-- mission_scores
-- ---------------------------------------------------------------------------
-- Scoring breakdown for each mission.
-- One row per mission; contains both final scores and all raw inputs so the
-- scoring is fully auditable and reproducible.
--
-- Score ranges:
--   impact_score         0.0 – 10.0
--   ecosystem_value_score 0.0 – 10.0
--   composite_score      0.0 – 10.0   (weighted combination)
--
-- Weights (v0.1 algorithm):
--   composite = (impact_score * 0.60) + (ecosystem_value_score * 0.40)
--   effort_label is categorical and applied as a tie-breaker, not a multiplier.
-- ---------------------------------------------------------------------------
CREATE TABLE mission_scores (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id              UUID          NOT NULL UNIQUE REFERENCES missions (id) ON DELETE CASCADE,

  -- Final scores (written once; recalculated on re-ingestion)
  impact_score            NUMERIC(4,1)  NOT NULL CHECK (impact_score    BETWEEN 0 AND 10),
  ecosystem_value_score   NUMERIC(4,1)  NOT NULL CHECK (ecosystem_value_score BETWEEN 0 AND 10),
  composite_score         NUMERIC(4,1)  NOT NULL CHECK (composite_score BETWEEN 0 AND 10),
  effort_label            effort_label  NOT NULL,

  -- Raw scoring inputs (stored verbatim for transparency / one-click audit)
  -- impact_inputs keys: cvss_score, severity, is_transitive, dep_type, days_since_advisory
  impact_inputs           JSONB         NOT NULL DEFAULT '{}',
  -- ecosystem_value_inputs keys: repo_stars, open_issues_count, downstream_dependents
  ecosystem_value_inputs  JSONB         NOT NULL DEFAULT '{}',
  -- effort_inputs keys: semver_bump, has_migration_guide, breaking_change_signals
  effort_inputs           JSONB         NOT NULL DEFAULT '{}',

  -- Data quality / confidence
  confidence              score_confidence NOT NULL,
  -- One or more human-readable notes explaining reduced confidence
  confidence_notes        TEXT[],
  -- e.g. '{"no_lock_file": true, "cvss_score_missing": true}'
  confidence_flags        JSONB         NOT NULL DEFAULT '{}',

  -- Which version of the scoring algorithm produced this row
  scoring_version         TEXT          NOT NULL DEFAULT '0.1.0',

  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_mission_scores_mission_id      ON mission_scores (mission_id);
CREATE INDEX idx_mission_scores_composite_score ON mission_scores (composite_score DESC);
CREATE INDEX idx_mission_scores_confidence      ON mission_scores (confidence);

-- ---------------------------------------------------------------------------
-- ingestion_runs
-- ---------------------------------------------------------------------------
-- Audit log of every ingestion job execution.
-- One row per (repo, run). Never deleted; used for debugging and replay.
-- ---------------------------------------------------------------------------
CREATE TABLE ingestion_runs (
  id                UUID              PRIMARY KEY DEFAULT gen_random_uuid(),

  repo_id           UUID              NOT NULL REFERENCES repos (id) ON DELETE CASCADE,

  -- Trigger source
  triggered_by      TEXT              NOT NULL,
  -- 'cron'      — GitHub Actions scheduled job
  -- 'manual'    — triggered manually via CLI or admin
  -- 'submit'    — triggered by a user submitting a repo

  status            ingestion_status  NOT NULL DEFAULT 'running',

  -- Counts for observability
  dependencies_found     INTEGER NOT NULL DEFAULT 0,
  advisories_fetched     INTEGER NOT NULL DEFAULT 0,
  missions_created       INTEGER NOT NULL DEFAULT 0,
  missions_updated       INTEGER NOT NULL DEFAULT 0,

  -- Error detail if status = 'failed'
  error_message     TEXT,
  error_stack       TEXT,

  -- Timing
  started_at        TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ,

  created_at        TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ingestion_runs_repo_id    ON ingestion_runs (repo_id);
CREATE INDEX idx_ingestion_runs_status     ON ingestion_runs (status);
CREATE INDEX idx_ingestion_runs_started_at ON ingestion_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- Updated_at trigger
-- Automatically updates the updated_at column on any row modification.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_repos_updated_at
  BEFORE UPDATE ON repos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_dependencies_updated_at
  BEFORE UPDATE ON dependencies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_advisories_updated_at
  BEFORE UPDATE ON advisories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_missions_updated_at
  BEFORE UPDATE ON missions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_mission_scores_updated_at
  BEFORE UPDATE ON mission_scores
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();