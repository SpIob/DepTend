# deptend.dev

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Live dashboard](https://img.shields.io/badge/live-deptend.vercel.app-brightgreen)](https://deptend.vercel.app)
[![GitHub stars](https://img.shields.io/github/stars/SpIob/DepTend?style=social)](https://github.com/SpIob/DepTend)

**deptend.dev** converts a GitHub repository's dependency data into a prioritized, explainable list of maintenance missions. Instead of a flat vulnerability feed, it tells you what to fix next by combining security impact, ecosystem value, and estimated effort into a single ranked list, with every score's inputs one click away.

**Live dashboard:** [deptend.vercel.app](https://deptend.vercel.app)

https://github.com/user-attachments/assets/e044e4af-7c11-43d4-bf60-76e5c814275d

deptend.dev mission board: a ranked, explainable list of maintenance missions

---

## Why this exists

Open-source maintainers face a flood of alerts, dependency updates, and issues with no clear way to prioritize any of it. deptend.dev takes that same data and ranks it by what's actually worth doing next: maintenance-first, not vulnerability-first.

Three constraints are non-negotiable and shape every decision in this project:

- **Zero budget.** Every tool, service, and dependency is free at the tier this project actually uses.
- **Solo developer.** Architecture and workflow stay manageable by one person.
- **Transparency-first.** No black-box scoring. Every mission shows its formula, its inputs, and its confidence level, never a bare number.

## Two ways to use it

**The hosted dashboard.** Visit [deptend.vercel.app](https://deptend.vercel.app). No account is needed to browse missions; GitHub sign-in is only required to submit a new repo or claim a mission.

**The CLI.** It runs the same scoring engine against a local repo path, entirely in-memory, with no account or hosted infrastructure required:

```bash
npx deptend <repo-path> --github-url <url> [--output <file>] [--json]
```

```bash
# Example
export GITHUB_TOKEN=<a token with public repo read access>  # recommended, raises GitHub's rate limit
npx deptend . --github-url https://github.com/your-username/your-repo --output missions.json
```

| Flag                 | Required         | Purpose                                                                                                                                                                                              |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<repo-path>`        | Yes (positional) | Local path to the repo root: the directory containing `package.json` (npm), `pyproject.toml`/`requirements.txt` (PyPI), or `go.mod` (Go). Ecosystem is auto-detected, npm first, then PyPI, then Go. |
| `--github-url <url>` | Yes              | The repo's GitHub URL, used to fetch stars/open-issues for ecosystem-value scoring. A local checkout alone can't derive this.                                                                        |
| `--output <file>`    | No               | Write the full JSON result to this file                                                                                                                                                              |
| `--json`             | No               | Print the full JSON result to stdout instead of the human-readable summary (ignored if `--output` is set)                                                                                            |

**`GITHUB_TOKEN`** (env var, optional but recommended) raises the GitHub API rate limit from 60 to 5,000 requests/hour. A fine-grained PAT with public-repo read access is sufficient.

The CLI reuses the exact same scoring and ranking code the dashboard runs: same formula, tie-break rules, and explainability. It doesn't touch a database and doesn't require the dashboard to be running. The CLI and dashboard are independent, cross-verified implementations of the same engine, not a client/server pair.

**Note on npx:** `@deptend/cli`'s `bin` entry is set up for `npx`-style invocation once published, but hasn't been published to the npm registry yet. Until then, run it from a local clone (see [Local development](#local-development) below), or use `pnpm --filter @deptend/cli exec deptend <args>` / `node cli/dist/index.js <args>` from the repo root after building.

## What a mission looks like

Every mission, on the dashboard or from the CLI, includes:

- What's affected: the package, its declared version range, and whether it's a production or development dependency.
- The advisory: source (OSV/GHSA), severity, CVSS score if available, a link to the original record, and the version that fixes it.
- The recommended action: a plain-language upgrade instruction.
- The score and every input that produced it: never a bare number.
- Confidence: visibly flagged when data is incomplete (no lock file parsed yet, no CVSS score, no downstream-dependents data), never hidden.

## The rescue board

Missions aren't private to a repo's own maintainer. The dashboard's board lists every open (and claimed) mission across all indexed repos, filterable by severity and effort. Any signed-in GitHub user can claim a mission, and release it later if they change their mind, turning a maintainer's backlog into something someone else can actually pick up and ship. No separate account, no gatekeeping beyond GitHub sign-in.

## How scoring works

```
composite_score = impact_score × 0.60 + ecosystem_value_score × 0.40
```

Impact comes from the CVSS score when one's available, or a severity-based estimate otherwise. It's discounted for development dependencies, since they don't ship to end users, and for transitive dependencies.

Ecosystem value is log-scaled repo stars and open issues, plus downstream dependents once that data source exists.

Effort is the semver bump size needed to reach the fixed version (patch/minor/major maps to trivial/low/.../high), refined by migration-guide data once that's ingested.

Missions are ranked by `composite_score`, bucketed into fixed-width tiers so near-equal scores don't produce an inconsistent order ([ADR 0017](docs/adr/0017-ranking-tie-break-transitivity-fix.md)). Within a tier, `effort_label` breaks the tie, a deliberate "prefer the quick win" rule. Below that, the tied advisory's own `published_at` (newest first) and finally its `osv_id` guarantee a fully deterministic order regardless of input order or ingestion timing ([ADR 0018](docs/adr/0018-ranking-final-tie-break.md)).

Full detail: [`docs/adr/0006-scoring-algorithm.md`](docs/adr/0006-scoring-algorithm.md).

> **On confidence right now:** every mission currently shows `low` confidence, by design and not as a bug. Two scoring inputs, downstream-dependents data and migration-guide/breaking-change signals, don't have a data source wired up yet, so the score stays deliberately conservative rather than implying more precision than the data supports. We're stating that plainly here instead of hiding it, consistent with the transparency principle above.

## Ecosystem support

Three ecosystems, auto-detected per repo in this order: npm first, then PyPI, then Go. A repo with manifests for more than one ecosystem detects as whichever is tried first; true multi-ecosystem-per-repo isn't supported.

| Ecosystem | Manifest read                                                                                        | Registry                                                                       | Notes                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| npm       | `package.json` only                                                                                  | [npm registry](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md) | First ecosystem ([ADR 0003](docs/adr/0003-npm-ecosystem-first.md))                                               |
| PyPI      | `pyproject.toml` ([PEP 621](https://peps.python.org/pep-0621/)) primary, `requirements.txt` fallback | [pypi.org JSON API](https://pypi.org/pypi/)                                    | Poetry's `[tool.poetry.dependencies]` table is out of scope ([ADR 0022](docs/adr/0022-phase6-pypi-ecosystem.md)) |
| Go        | `go.mod` `require` directives, direct only                                                           | [proxy.golang.org](https://proxy.golang.org/)                                  | `replace`/`exclude`/`retract` directives not handled ([ADR 0024](docs/adr/0024-go-ecosystem.md))                 |

Lock files (`package-lock.json`/`pnpm-lock.yaml`/`yarn.lock` for npm, `go.sum` for Go) are detected but never parsed: resolved versions are estimated from declared ranges rather than confirmed. This is visibly flagged as lower confidence wherever it applies, never silently assumed.

A repo whose manifest lives outside the repo root is currently indistinguishable from a repo with no manifest at all; both land on `ingestionStatus: 'skipped'`. This is a scoping choice (root-only parsing), not a bug.

## Tech stack

| Layer           | Choice                                                                                                                                                                                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend        | Next.js 15 + Tailwind CSS                                                                                                                                                                                                                                                                                                        |
| Backend         | Next.js API routes                                                                                                                                                                                                                                                                                                               |
| Database        | PostgreSQL ([Neon](https://neon.tech/) free tier)                                                                                                                                                                                                                                                                                |
| ORM             | [Drizzle ORM](https://orm.drizzle.team/) + Drizzle Kit                                                                                                                                                                                                                                                                           |
| Auth            | GitHub OAuth ([next-auth](https://next-auth.js.org/) v4), JWT sessions                                                                                                                                                                                                                                                           |
| Hosting         | [Vercel](https://vercel.com/) Hobby                                                                                                                                                                                                                                                                                              |
| CI/CD           | GitHub Actions: lint/typecheck/test on every PR, nightly ingestion cron, on-demand ingestion on repo submission                                                                                                                                                                                                                  |
| Data sources    | [OSV.dev](https://osv.dev/docs/) / [GitHub Advisory Database](https://github.com/advisories), [npm registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md), [pypi.org JSON API](https://pypi.org/pypi/), [proxy.golang.org](https://proxy.golang.org/), [GitHub REST API](https://docs.github.com/en/rest) |
| CLI             | Node.js, npx-runnable                                                                                                                                                                                                                                                                                                            |
| Package manager | [pnpm](https://pnpm.io/) workspaces                                                                                                                                                                                                                                                                                              |
| Language        | TypeScript (JS permitted only in `scripts/`)                                                                                                                                                                                                                                                                                     |
| Testing         | [Vitest](https://vitest.dev/)                                                                                                                                                                                                                                                                                                    |
| Lint/format     | ESLint 9 (flat config) + typescript-eslint, Prettier                                                                                                                                                                                                                                                                             |

Every choice above is free at the tier this project uses. See [`docs/adr/`](docs/adr/) for the reasoning behind each one.

## Monorepo structure

```
deptend.dev/
├── app/              # Next.js frontend + API routes (the hosted dashboard)
├── cli/              # npx-runnable CLI companion
├── packages/core/     # @deptend/core: shared ingestion + scoring engine, used by both app/ and cli/
├── scripts/          # GitHub Actions cron entry point (real ingestion pipeline)
├── docs/
│   ├── adr/           # One Architecture Decision Record per major technical choice, numbered sequentially
│   └── data-model/    # Entity reference, kept in sync with packages/core/src/db/schema.ts
└── .github/workflows/ # ci.yml (lint/typecheck/test), ingest.yml (cron + on-demand ingestion)
```

`packages/core/src/db/schema.ts` is the single source of truth for every database type (see [ADR 0011](docs/adr/0011-schema-as-single-type-source.md)).

## Local development

Requires Node.js ≥20 and [pnpm](https://pnpm.io/installation) ≥9 (this project pins `9.15.0`).

1. **Clone and install**

   ```bash
   git clone https://github.com/SpIob/DepTend
   cd deptend.dev
   pnpm install
   ```

   (`pnpm install` also builds `packages/core` automatically via a root `postinstall` hook, so there's nothing else to build by hand for a first-time setup.)

2. **Set up environment variables.** Copy `.env.example` to `.env.local` and fill it in:
   - `DATABASE_URL` / `DATABASE_URL_UNPOOLED`: from a free [Neon](https://neon.tech/) project (pooled and direct connection strings; the direct one is required for schema/migration work). Use a Neon branch, not the same branch Vercel's Production environment points at. Neon branches are free (copy-on-write, no card required) and keep local test submissions off the live public mission board (see [ADR 0023](docs/adr/0023-dev-prod-database-separation.md)).
   - `GH_CLIENT_ID` / `GH_CLIENT_SECRET`: from a [GitHub OAuth App](https://github.com/settings/developers) with callback URL `http://localhost:3000/api/auth/callback/github`
   - `NEXTAUTH_SECRET`: generate with `openssl rand -base64 32`
   - `NEXTAUTH_URL`: `http://localhost:3000` for local dev
   - `GITHUB_TOKEN`: a personal access token (read-only, public repos) for ingestion and CLI use
   - `GH_DISPATCH_TOKEN` / `GH_REPO`: leave these blank in local `.env.local`. They fire a real GitHub Actions run, and that workflow's `DATABASE_URL` is a repo secret pointing at the production branch, so it can never see a repo row that only exists in your local dev branch (ADR 0023). Only set these in Vercel's Production environment, where the submitter's DB and the workflow's DB are the same branch. Leaving them blank locally makes repo submission fall back to a "will be processed on the next scheduled run" message instead of dispatching a run that's guaranteed to fail. See step 5 for how to actually ingest a locally-submitted repo.

3. **Apply the database schema** (replays the existing migration history; this project uses migration files rather than `drizzle-kit push`)

   ```bash
   pnpm drizzle-kit migrate
   ```

   **Known issue:** `drizzle-kit migrate` reliably hangs on `ALTER TYPE ... ADD VALUE` statements specifically. That's 2-for-2 in this project's own history, and it isn't lock contention (ruled out via `pg_stat_activity`; see [ADR 0021](docs/adr/0021-ingestion-status-skipped.md)). If it hangs, kill it and apply that one migration's `.sql` file directly in Neon's SQL Editor instead. That's the expected path for enum additions now, not a last-resort fallback (see [ADR 0026](docs/adr/0026-migration-bookkeeping-backfill.md)). Everything else (table/column changes) has run fine through the CLI so far.

4. **Run the dashboard**

   ```bash
   pnpm --filter app dev
   ```

   Visit `http://localhost:3000`. OAuth sign-in only round-trips correctly from a stable URL that matches your OAuth App's registered callback, not from arbitrary preview URLs.

5. **Run an ingestion manually.** With `GH_DISPATCH_TOKEN`/`GH_REPO` unset locally (step 2), this is now the only way to populate mission data for a repo you submitted through the local dashboard, since neither the nightly cron nor an on-demand dispatch can reach your dev branch:

   ```bash
   # For a repo already submitted through the local dashboard's UI:
   node --env-file=.env.local scripts/ingest.js --repo-id <the-repo's-uuid> --triggered-by manual

   # Or skip the UI and ingest any repo directly by URL:
   node --env-file=.env.local scripts/ingest.js --repo-url https://github.com/owner/name --triggered-by manual
   ```

6. **Build and try the CLI**

   ```bash
   pnpm --filter @deptend/cli build
   node cli/dist/index.js /path/to/a/local/repo --github-url https://github.com/owner/name
   ```

7. **Verify your changes.** This is the standard loop this project uses before every commit, run from a fully clean state:
   ```bash
   rm -rf packages/core/dist app/.next cli/dist
   pnpm typecheck && pnpm test && pnpm build && pnpm lint && pnpm format:check
   ```

## Status

DepTend is live and under active development. New features and fixes ship regularly, and the UI is currently undergoing a refactor toward a more minimal, modern look. See [`docs/adr/`](docs/adr/) for the decision history.

## Contributing

This is currently a solo-maintained project without a formal contribution process yet. If you want to help without maintaining a project of your own, the [rescue board](#the-rescue-board) is the fastest way in: claim an open mission on any indexed repo. Issues and discussion are welcome via the GitHub repo's issue tracker, also used as the project's task board since there's no external project management tool, per the project's zero-budget/solo-dev principles.

**Documentation convention:** [`CHANGELOG.md`](CHANGELOG.md) is the condensed, skimmable index of what shipped and when. Full reasoning, alternatives considered, and retroactive fixes live in the corresponding [ADR(s)](docs/adr/) instead of being duplicated there. Any change that writes a new ADR under the project's own standing rule (schema change, scoring-algorithm change, or another major user/dev-facing change) gets a matching one- or two-line `CHANGELOG.md` entry in the same commit or PR, added to the current "Post-Phase N" / `[Unreleased]` section at the top, not backfilled later. This keeps the changelog from drifting the way `docs/data-model/README.md` did.

## License

MIT. See [`LICENSE`](LICENSE) for the full text.
