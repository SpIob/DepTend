# deptend.dev — Data Model Reference

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
  └─── ingestion_runs (one repo → many runs, append-only)
```

---

## Tables

### `repos`

Tracks GitHub repositories submitted for analysis.

| Column              | Type         | Notes                                      |
| ------------------- | ------------ | ------------------------------------------ |
| `id`                | uuid PK      | gen_random_uuid()                          |
| `github_url`        | text UNIQUE  | `https://github.com/{owner}/{name}`        |
| `owner`             | text         | GitHub org or username                     |
| `name`              | text         | Repo name                                  |
| `default_branch`    | text         | Default: `'main'`                          |
| `description`       | text?        | From GitHub API                            |
| `stars`             | integer      | Refreshed each ingestion                   |
| `open_issues_count` | integer      | Refreshed each ingestion                   |
| `topics`            | text[]       | GitHub repo topics                         |
| `homepage_url`      | text?        | From GitHub API                            |
| `ingestion_status`  | enum         | `pending \| running \| complete \| failed` |
| `last_ingested_at`  | timestamptz? | NULL until first completed run             |
| `ingestion_error`   | text?        | Last error message                         |
| `submitted_by`      | text?        | GitHub username; NULL for CLI-submitted    |
| `created_at`        | timestamptz  |                                            |
| `updated_at`        | timestamptz  | Managed by trigger                         |

**MVP constraint:** Maximum 3 rows. Enforced at application layer.

---

### `dependencies`

One row per `(repo, package_name, dep_type)`.

| Column             | Type            | Notes                                           |
| ------------------ | --------------- | ----------------------------------------------- |
| `id`               | uuid PK         |                                                 |
| `repo_id`          | uuid FK → repos | CASCADE on delete                               |
| `ecosystem`        | enum            | `npm` (Phase 1 only)                            |
| `package_name`     | text            | e.g. `lodash`                                   |
| `version_spec`     | text            | Range from package.json, e.g. `^4.17.0`         |
| `resolved_version` | text?           | From lock file; NULL in Phase 1 baseline        |
| `dep_type`         | enum            | `production \| development \| peer \| optional` |
| `latest_version`   | text?           | Fetched from registry at ingest time            |
| `is_deprecated`    | boolean         |                                                 |
| `deprecation_note` | text?           | Registry deprecation message                    |
| `created_at`       | timestamptz     |                                                 |
| `updated_at`       | timestamptz     |                                                 |

---

### `advisories`

Global advisory records from OSV and GHSA. Shared across repos.

| Column              | Type          | Notes                                          |
| ------------------- | ------------- | ---------------------------------------------- |
| `id`                | uuid PK       |                                                |
| `osv_id`            | text UNIQUE   | e.g. `GHSA-p6mc-r536-x9xx`                     |
| `source`            | enum          | `osv \| ghsa`                                  |
| `ecosystem`         | enum          | `npm`                                          |
| `package_name`      | text          |                                                |
| `severity`          | enum          | `critical \| high \| medium \| low \| unknown` |
| `cvss_score`        | numeric(4,1)? | 0.0–10.0; NULL when not provided               |
| `summary`           | text          | Short title                                    |
| `details`           | text?         | Full description                               |
| `affected_versions` | jsonb         | OSV `ranges` array                             |
| `fixed_version`     | text?         | First patched version; NULL if unpatched       |
| `published_at`      | timestamptz?  |                                                |
| `modified_at`       | timestamptz?  | Used to detect advisory updates                |
| `raw_data`          | jsonb         | Full source payload for auditability           |
| `created_at`        | timestamptz   |                                                |
| `updated_at`        | timestamptz   |                                                |

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

| Column           | Type                    | Notes                                                             |
| ---------------- | ----------------------- | ----------------------------------------------------------------- |
| `id`             | uuid PK                 |                                                                   |
| `repo_id`        | uuid FK → repos         | CASCADE on delete                                                 |
| `title`          | text                    | Human-readable; e.g. "Patch CVE-2024-… in lodash"                 |
| `description`    | text                    | Plain-language explanation                                        |
| `action_hint`    | text?                   | e.g. `pnpm update lodash`                                         |
| `mission_type`   | enum                    | `vulnerability_fix \| dep_update \| maintenance \| license_issue` |
| `status`         | enum                    | `open \| claimed \| resolved \| dismissed`                        |
| `advisory_id`    | uuid? FK → advisories   | SET NULL on delete                                                |
| `dependency_id`  | uuid? FK → dependencies | SET NULL on delete                                                |
| `claimed_by`     | text?                   | GitHub username; Phase 5                                          |
| `claimed_at`     | timestamptz?            |                                                                   |
| `resolved_at`    | timestamptz?            |                                                                   |
| `dismissed_at`   | timestamptz?            |                                                                   |
| `dismiss_reason` | text?                   |                                                                   |
| `created_at`     | timestamptz             |                                                                   |
| `updated_at`     | timestamptz             |                                                                   |

---

### `mission_scores`

One row per mission. Stores final scores AND all raw inputs for full auditability.

| Column                   | Type                      | Notes                                            |
| ------------------------ | ------------------------- | ------------------------------------------------ |
| `id`                     | uuid PK                   |                                                  |
| `mission_id`             | uuid FK → missions UNIQUE | One score per mission                            |
| `impact_score`           | numeric(4,1)              | 0.0–10.0                                         |
| `ecosystem_value_score`  | numeric(4,1)              | 0.0–10.0                                         |
| `composite_score`        | numeric(4,1)              | `(impact × 0.60) + (ecosystem_value × 0.40)`     |
| `effort_label`           | enum                      | `trivial \| low \| medium \| high`               |
| `impact_inputs`          | jsonb                     | See `ImpactInputs` in `db/json-types.ts`         |
| `ecosystem_value_inputs` | jsonb                     | See `EcosystemValueInputs` in `db/json-types.ts` |
| `effort_inputs`          | jsonb                     | See `EffortInputs` in `db/json-types.ts`         |
| `confidence`             | enum                      | `high \| medium \| low`                          |
| `confidence_notes`       | text[]?                   | Human-readable confidence warnings               |
| `confidence_flags`       | jsonb                     | Programmatic flags (e.g. `{no_lock_file: true}`) |
| `scoring_version`        | text                      | Algorithm version that produced this row         |
| `created_at`             | timestamptz               |                                                  |
| `updated_at`             | timestamptz               |                                                  |

**Composite score formula (v0.1):**

```
composite = (impact_score × 0.60) + (ecosystem_value_score × 0.40)
```

`effort_label` is applied as a categorical tie-breaker in the sort order — it does not enter the numeric formula.

---

### `ingestion_runs`

Append-only audit log. Rows are never updated or deleted.

| Column               | Type            | Notes                                      |
| -------------------- | --------------- | ------------------------------------------ |
| `id`                 | uuid PK         |                                            |
| `repo_id`            | uuid FK → repos | CASCADE on delete                          |
| `triggered_by`       | text            | `cron \| manual \| submit`                 |
| `status`             | enum            | `pending \| running \| complete \| failed` |
| `dependencies_found` | integer         |                                            |
| `advisories_fetched` | integer         |                                            |
| `missions_created`   | integer         |                                            |
| `missions_updated`   | integer         |                                            |
| `error_message`      | text?           |                                            |
| `error_stack`        | text?           |                                            |
| `started_at`         | timestamptz     |                                            |
| `finished_at`        | timestamptz?    | NULL while running                         |
| `created_at`         | timestamptz     |                                            |

---

## Enum reference

| Enum               | Values                                                            |
| ------------------ | ----------------------------------------------------------------- |
| `ingestion_status` | `pending`, `running`, `complete`, `failed`                        |
| `dep_type`         | `production`, `development`, `peer`, `optional`                   |
| `ecosystem`        | `npm`                                                             |
| `advisory_source`  | `osv`, `ghsa`                                                     |
| `severity`         | `critical`, `high`, `medium`, `low`, `unknown`                    |
| `mission_type`     | `vulnerability_fix`, `dep_update`, `maintenance`, `license_issue` |
| `mission_status`   | `open`, `claimed`, `resolved`, `dismissed`                        |
| `effort_label`     | `trivial`, `low`, `medium`, `high`                                |
| `score_confidence` | `high`, `medium`, `low`                                           |

---

## Schema changelog

| Version | Date       | Change                                                                                                                                                                                         |
| ------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1.0   | 2026-06-29 | Initial schema — Phase 0                                                                                                                                                                       |
| 0.1.1   | 2026-07-09 | ADR 0011: schema.ts is now the sole row-type source (db/types.ts removed); jsonb columns and numeric score columns gained precise TS types via `.$type<>()` / `mode: "number"` — no DDL change |
