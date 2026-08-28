# DepTend — Data Model Reference

_Auto-sync this document with `packages/core/src/db/schema.ts` on every schema change. Column types below reflect the TypeScript-level types after ADR 0011 (`schema.ts` is the sole row-type source; JSONB payload shapes live in `packages/core/src/db/json-types.ts`)._

---

## Entity Relationship Summary

```
repos
  │
  ├─── dependencies (one repo → many deps)
  │        │
  │        └─── dependency_advisories (many deps ↔ many advisories)
  │                    │
  │               advisories (shared across all repos)
  │
  ├─── missions (one repo → many missions)
  │        │
  │        └─── mission_scores (one mission → one score)
  │
  ├─── repo_bookmarks (one repo → many user bookmarks)
  │
  ├─── ingestion_runs (one repo → many runs, append-only)
  │
  └─── notification_subscriptions (one repo → many user notification prefs)

organizations
  │
  └─── organization_members (one org → many user memberships)
  │
  └─── repos (one org → many repos, via repos.org_id)
```

---

## Tables

### `repos`

Tracks GitHub repositories submitted for analysis.

| Column              | Type                     | Notes                                                      |
| ------------------- | ------------------------ | ---------------------------------------------------------- |
| `id`                | uuid PK                  | gen_random_uuid()                                          |
| `github_url`        | text UNIQUE              | `https://github.com/{owner}/{name}`                        |
| `owner`             | text                     | GitHub org or username                                     |
| `name`              | text                     | Repo name                                                  |
| `default_branch`    | text                     | Default: `'main'`                                          |
| `description`       | text?                    | From GitHub API                                            |
| `stars`             | integer                  | Refreshed each ingestion                                   |
| `open_issues_count` | integer                  | Refreshed each ingestion                                   |
| `topics`            | text[]                   | GitHub repo topics                                         |
| `homepage_url`      | text?                    | From GitHub API                                            |
| `ingestion_status`  | enum                     | `pending \| running \| complete \| failed \| skipped`      |
| `last_ingested_at`  | timestamptz?             | NULL until first completed run; drives stale re-ingestion  |
| `ingestion_error`   | text?                    | Last error message; also holds the reason for `skipped`    |
| `submitted_by`      | text?                    | GitHub username; NULL for CLI-submitted                    |
| `org_id`            | uuid? FK → organizations | SET NULL on delete; added in 0.1.8 (organizations feature) |
| `created_at`        | timestamptz              |                                                            |
| `updated_at`        | timestamptz              | Managed by trigger                                         |

**MVP constraint:** Maximum 150 rows (`NEXT_PUBLIC_MAX_REPOS`, raised from 3 to 10 -- ADR 0020 -- then 10 to 150 for launch -- ADR 0028). Enforced at application layer.

**Status lifecycle:** cron runs pick `pending`/`failed` first (fresh submissions, retryable errors), then up to a capped batch of `complete` repos whose `last_ingested_at` is older than the staleness threshold (`REINGEST_STALE_DAYS`, default 7) — so indexed boards keep tracking upstream reality. `skipped` is terminal on both paths into it: no analyzable manifest at ingestion time, or the repo no longer exists on GitHub (`not_found`) — neither is ever re-picked.

---

### `dependencies`

One row per `(repo, package_name, dep_type)`.

The set is reconciled against the manifest on every successful ingestion: rows for packages the manifest no longer lists are deleted (cascading their `dependency_advisories`; missions survive via SET NULL on `dependency_id`). A run that couldn't read the manifest never prunes — an unreadable manifest defines nothing.

| Column             | Type            | Notes                                                         |
| ------------------ | --------------- | ------------------------------------------------------------- |
| `id`               | uuid PK         |                                                               |
| `repo_id`          | uuid FK → repos | CASCADE on delete                                             |
| `ecosystem`        | enum            | `npm \| pypi \| go`                                           |
| `package_name`     | text            | e.g. `lodash`                                                 |
| `version_spec`     | text            | Range from package.json, e.g. `^4.17.0`                       |
| `resolved_version` | text?           | From lock file; NULL in Phase 1 baseline                      |
| `dep_type`         | enum            | `production \| development \| peer \| optional \| transitive` |
| `latest_version`   | text?           | Fetched from registry at ingest time                          |
| `is_deprecated`    | boolean         |                                                               |
| `deprecation_note` | text?           | Registry deprecation message                                  |
| `created_at`       | timestamptz     |                                                               |
| `updated_at`       | timestamptz     |                                                               |

---

### `advisories`

Global advisory records from OSV and GHSA. Shared across repos.

| Column              | Type          | Notes                                                                                                |
| ------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `id`                | uuid PK       |                                                                                                      |
| `osv_id`            | text UNIQUE   | e.g. `GHSA-p6mc-r536-x9xx`                                                                           |
| `source`            | enum          | `osv \| ghsa`                                                                                        |
| `ecosystem`         | enum          | `npm \| pypi \| go`                                                                                  |
| `package_name`      | text          |                                                                                                      |
| `severity`          | enum          | `critical \| high \| medium \| low \| unknown`                                                       |
| `cvss_score`        | numeric(4,1)? | 0.0–10.0; NULL when not provided                                                                     |
| `epss_score`        | numeric(6,5)? | 0.00000–1.00000; EPSS exploitability probability from FIRST.org (ADR 0039). NULL when not available. |
| `summary`           | text          | Short title                                                                                          |
| `details`           | text?         | Full description                                                                                     |
| `affected_versions` | jsonb         | OSV `ranges` array                                                                                   |
| `fixed_version`     | text?         | First patched version; NULL if unpatched                                                             |
| `published_at`      | timestamptz?  |                                                                                                      |
| `modified_at`       | timestamptz?  | Used to detect advisory updates                                                                      |
| `raw_data`          | jsonb         | Full source payload for auditability                                                                 |
| `created_at`        | timestamptz   |                                                                                                      |
| `updated_at`        | timestamptz   |                                                                                                      |

---

### `dependency_advisories`

Junction table. Produced during ingestion after version range evaluation.

| Column          | Type                   | Notes                                          |
| --------------- | ---------------------- | ---------------------------------------------- |
| `id`            | uuid PK                |                                                |
| `dependency_id` | uuid FK → dependencies | CASCADE on delete                              |
| `advisory_id`   | uuid FK → advisories   | CASCADE on delete                              |
| `is_affected`   | boolean                | True if installed version is in affected range |
| `match_method`  | text                   | `version_spec` or `resolved_version`           |
| `created_at`    | timestamptz            |                                                |

UNIQUE constraint on `(dependency_id, advisory_id)`.

---

### `missions`

Ranked maintenance work items shown on the dashboard.

| Column           | Type                    | Notes                                                                |
| ---------------- | ----------------------- | -------------------------------------------------------------------- |
| `id`             | uuid PK                 |                                                                      |
| `repo_id`        | uuid FK → repos         | CASCADE on delete                                                    |
| `title`          | text                    | Human-readable; e.g. "Patch CVE-2024-… in lodash"                    |
| `description`    | text                    | Plain-language explanation                                           |
| `action_hint`    | text?                   | e.g. `pnpm update lodash`                                            |
| `mission_type`   | enum                    | `vulnerability_fix \| dep_update \| maintenance \| license_issue`    |
| `status`         | enum                    | `open \| claimed \| resolved \| dismissed`                           |
| `advisory_id`    | uuid? FK → advisories   | SET NULL on delete                                                   |
| `dependency_id`  | uuid? FK → dependencies | SET NULL on delete                                                   |
| `claimed_by`     | text?                   | GitHub username; Phase 5                                             |
| `claimed_at`     | timestamptz?            |                                                                      |
| `resolved_at`    | timestamptz?            | Set by the pipeline's auto-resolution pass or a future manual flow   |
| `dismissed_at`   | timestamptz?            | Set by the dismiss endpoint (any signed-in user, open missions only) |
| `dismiss_reason` | text?                   | Optional bounded plain-text reason from the dismiss endpoint         |
| `created_at`     | timestamptz             |                                                                      |
| `updated_at`     | timestamptz             |                                                                      |

**Status lifecycle:** `resolved` and `dismissed` are both reachable. The pipeline closes open/claimed missions as `resolved` when their `(dependency_id, advisory_id)` pair produces no candidate in a re-ingestion run — dependency pruned from the manifest, advisory range no longer matching, or the advisory withdrawn; a previously auto-resolved mission whose pair returns is reopened. `dismissed` is a human decision via `POST /api/missions/[id]/dismiss` (open missions only), reversible via `/undismiss`. Claim fields survive auto-resolution as history; dismissal of claimed missions requires unclaiming first.

---

### `mission_scores`

One row per mission. Stores final scores AND all raw inputs for full auditability.

| Column                   | Type                      | Notes                                                                                     |
| ------------------------ | ------------------------- | ----------------------------------------------------------------------------------------- |
| `id`                     | uuid PK                   |                                                                                           |
| `mission_id`             | uuid FK → missions UNIQUE | One score per mission                                                                     |
| `impact_score`           | numeric(4,1)              | 0.0–10.0                                                                                  |
| `ecosystem_value_score`  | numeric(4,1)              | 0.0–10.0                                                                                  |
| `composite_score`        | numeric(4,1)              | `(impact × 0.60) + (ecosystem_value × 0.40)`                                              |
| `effort_label`           | enum                      | `trivial \| low \| medium \| high`                                                        |
| `impact_inputs`          | jsonb                     | See `ImpactInputs` in `db/json-types.ts`                                                  |
| `ecosystem_value_inputs` | jsonb                     | See `EcosystemValueInputs` in `db/json-types.ts`                                          |
| `effort_inputs`          | jsonb                     | See `EffortInputs` in `db/json-types.ts`                                                  |
| `confidence`             | enum                      | `high \| medium \| low`                                                                   |
| `confidence_notes`       | text[]?                   | Human-readable confidence warnings                                                        |
| `confidence_flags`       | jsonb                     | Programmatic flags (e.g. `{no_lock_file: true, downstream_dependents_unavailable: true}`) |
| `scoring_version`        | text                      | Algorithm version that produced this row                                                  |
| `created_at`             | timestamptz               |                                                                                           |
| `updated_at`             | timestamptz               |                                                                                           |

Confidence inputs come from two data sources wired up after this table was first written: `ecosystem_value_inputs.downstream_dependents` (libraries.io, [ADR 0032](../adr/0032-downstream-dependents.md)) and `effort_inputs.has_migration_guide` / `effort_inputs.breaking_change_signals` (GitHub Releases, [ADR 0029](../adr/0029-breaking-change-signals.md)). When a source can't resolve for a mission, the corresponding `_unavailable` flag is set in `confidence_flags` and the mission stays at lower confidence.

**Composite score formula (v0.1):**

```
composite = (impact_score × 0.60) + (ecosystem_value_score × 0.40)
```

`effort_label` is applied as a categorical tie-breaker in the sort order — it does not enter the numeric formula.

---

### `ingestion_runs`

Append-only audit log. Rows are never updated or deleted.

| Column               | Type            | Notes                                                 |
| -------------------- | --------------- | ----------------------------------------------------- |
| `id`                 | uuid PK         |                                                       |
| `repo_id`            | uuid FK → repos | CASCADE on delete                                     |
| `triggered_by`       | text            | `cron \| manual \| submit`                            |
| `status`             | enum            | `pending \| running \| complete \| failed \| skipped` |
| `dependencies_found` | integer         |                                                       |
| `advisories_fetched` | integer         |                                                       |
| `missions_created`   | integer         |                                                       |
| `missions_updated`   | integer         |                                                       |
| `error_message`      | text?           |                                                       |
| `error_stack`        | text?           |                                                       |
| `started_at`         | timestamptz     |                                                       |
| `finished_at`        | timestamptz?    | NULL while running                                    |
| `created_at`         | timestamptz     |                                                       |

---

### `repo_bookmarks`

Per-user repo bookmarks (ADR 0027). `user_login` stores the GitHub login directly — same
pattern as `missions.claimed_by` / `repos.submitted_by`; no separate users table exists.

| Column       | Type            | Notes                                |
| ------------ | --------------- | ------------------------------------ |
| `id`         | uuid PK         | gen_random_uuid()                    |
| `repo_id`    | uuid FK → repos | CASCADE on delete                    |
| `user_login` | text            | GitHub login of the bookmarking user |
| `created_at` | timestamptz     |                                      |

UNIQUE constraint on `(user_login, repo_id)` — leads with `user_login`, since "list this
user's bookmarks" (the repo directory's read pattern) is the primary access path.

---

### `organizations`

Optional grouping for repos under a GitHub organization login. Repos point at an org via
`repos.org_id`; the inverse — listing an org's repos — is the read pattern behind
`/org/[org]` (organizations directory view).

| Column         | Type        | Notes                               |
| -------------- | ----------- | ----------------------------------- |
| `id`           | uuid PK     | gen_random_uuid()                   |
| `github_login` | text UNIQUE | The GitHub org login, e.g. `vercel` |
| `name`         | text?       | Display name; NULL until fetched    |
| `avatar_url`   | text?       | From GitHub API; NULL until fetched |
| `created_at`   | timestamptz |                                     |
| `updated_at`   | timestamptz | Managed by trigger                  |

`repos.org_id` is `SET NULL` on org delete — repos survive independently; the org reference
just goes blank.

---

### `organization_members`

Per-org membership (read-only; the UI doesn't gate anything on role yet — the `role`
column is in place for the future). The `role` value is `owner | admin | member` but
no UI surface reads it.

| Column            | Type                    | Notes                      |
| ----------------- | ----------------------- | -------------------------- |
| `id`              | uuid PK                 |                            |
| `organization_id` | uuid FK → organizations | CASCADE on delete          |
| `user_login`      | text                    | GitHub login               |
| `role`            | text                    | `owner \| admin \| member` |
| `created_at`      | timestamptz             |                            |

UNIQUE constraint on `(organization_id, user_login)`.

---

### `notification_subscriptions`

User opt-in to be notified about repo events. Delivery is via GitHub Issues on the
DepTend repo itself (zero-budget, per ADR 0032's standing rule). `event_types` is the
array the user subscribed to; `github_issue_number` is the open issue DepTend uses
as the user's "inbox" on its own repo.

| Column                | Type            | Notes                                                                              |
| --------------------- | --------------- | ---------------------------------------------------------------------------------- |
| `id`                  | uuid PK         | gen_random_uuid()                                                                  |
| `user_login`          | text            | GitHub login                                                                       |
| `repo_id`             | uuid FK → repos | CASCADE on delete                                                                  |
| `event_types`         | text[]          | One or more of `new_mission \| claimed \| resolved`; defaults to all three         |
| `github_issue_number` | integer?        | Open issue on SpIob/DepTend used as the per-user delivery inbox; NULL until opened |
| `created_at`          | timestamptz     |                                                                                    |

UNIQUE constraint on `(user_login, repo_id)`.

---

## Enum reference

| Enum               | Values                                                            |
| ------------------ | ----------------------------------------------------------------- |
| `ingestion_status` | `pending`, `running`, `complete`, `failed`, `skipped`             |
| `dep_type`         | `production`, `development`, `peer`, `optional`, `transitive`     |
| `ecosystem`        | `npm`, `pypi`, `go`                                               |
| `advisory_source`  | `osv`, `ghsa`                                                     |
| `severity`         | `critical`, `high`, `medium`, `low`, `unknown`                    |
| `mission_type`     | `vulnerability_fix`, `dep_update`, `maintenance`, `license_issue` |
| `mission_status`   | `open`, `claimed`, `resolved`, `dismissed`                        |
| `effort_label`     | `trivial`, `low`, `medium`, `high`                                |
| `score_confidence` | `high`, `medium`, `low`                                           |

---

## Schema changelog

| Version | Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0.1.0   | 2026-06-29 | Initial schema — Phase 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 0.1.1   | 2026-07-09 | ADR 0011: schema.ts is now the sole row-type source (db/types.ts removed); jsonb columns and numeric score columns gained precise TS types via `.$type<>()` / `mode: "number"` — no DDL change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 0.1.2   | 2026-07-22 | ADR 0021 (migration `0001`): `'skipped'` added to `ingestion_status`, distinct from `'complete'`/`'failed'`; plus 3 pre-existing `SET DEFAULT` drift fixes on `mission_scores`' jsonb columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 0.1.3   | 2026-07-25 | ADR 0022 (migration `0002`): `'pypi'` added to `ecosystem`. No `repos.ecosystem` column — ecosystem is decided per-ingestion by `detectEcosystem`, recorded per-row on `dependencies`/`advisories` only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 0.1.4   | 2026-07-25 | ADR 0024 (migration `0003`): `'go'` added to `ecosystem`, same pattern as 0.1.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 0.1.5   | 2026-07-30 | ADR 0027 (migration `0004`): `repo_bookmarks` table added — per-user repo bookmarks for the directory/browse view, unique `(user_login, repo_id)`; no DDL change to existing tables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 0.1.6   | 2026-08-23 | ADR 0034 (migration `0005`): composite index `idx_dependencies_repo_ecosystem (repo_id, ecosystem)` — index-only scan for the directory page's distinct pair; no column or row-type changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 0.1.7   | 2026-08-25 | ADR 0035 (migration `0006`): index `idx_missions_dependency_id (dependency_id)` — serves MissionWriter's bulk existing-mission check; no column or row-type changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 0.1.8   | 2026-08-28 | ADR 0040 (migration `0007_foamy_chimera`): the consolidated diff of four previously-unregistered hand-written SQL files (`0007`–`0010`) that the prior commit (`a539d8e`) had added without journal entries. Adds: `organizations` + `organization_members` + `notification_subscriptions` tables, `repos.org_id` FK to organizations, `transitive` value to `dep_type`, `advisories.epss_score` column, the `mission_scores.impact_inputs` default refresh with the `epss_score` field, and the four board-query composite indexes (`idx_advisories_severity_id`, `idx_dependencies_ecosystem_id`, `idx_mission_scores_effort_composite`, `idx_missions_status_repo`, `idx_repos_org_id`) |
