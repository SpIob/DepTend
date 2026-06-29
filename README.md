# deptend.dev

**deptend.dev** is a public, repo-aware web dashboard that converts dependency and issue data into prioritized maintenance missions. Unlike generic vulnerability dashboards, it tells a developer what to fix next and surfaces neglected but high-leverage work for open-source ecosystems. It links security, upkeep, and contributor coordination in one place rather than treating them as separate problems.

## Why this exists?

Open-source maintainers are often overwhelmed by a flood of alerts, dependency updates, and issues, with no clear path on what to prioritize. `deptend.dev` was built to cut through the noise. It is founded on three non-negotiable principles:

- **Zero budget** — Every tool, service, and dependency is completely free at the required usage tier.
- **Solo developer** — The architecture, scope, and workflow decisions are manageable by one person.
- **Transparency-first** — No dark-pattern gamification, no proprietary lock-in, no claim that automation replaces human judgment.

## The Goal

The primary goal is to deliver an MVP that ingests public repository data, runs lightweight dependency and issue analysis, and produces a ranked, explainable list of maintenance missions — deployable at zero cost and usable without an account.

Secondary goals include establishing a local-first workflow, targeting open-source maintainers and tiny engineering teams, and keeping every recommendation explainable (no black-box scoring).

## The Three Score Components

Each mission is scored and labeled based on three components:

- **Impact**: How critical is the fix? (Security, performance, or compatibility)
- **Effort**: How much work is required? (Sizes: Small, Medium, Large)
- **Ecosystem Value**: How beneficial is this fix to the broader community? (Dependency health, popularity)

## Tech Stack

The project follows a local-first, repo-native model: a static frontend plus a lightweight backend API, with a CLI companion that can export JSON into the site.

- **Frontend**: [Next.js](https://nextjs.org/) + [Tailwind CSS](https://tailwindcss.com/)
- **Backend**: Next.js API routes (Node.js)
- **Database**: PostgreSQL ([Neon](https://neon.tech/) free tier) / SQLite for local offline use
- **Job Queue**: GitHub Actions cron jobs
- **Data Sources**: [OSV.dev](https://osv.dev/docs/) / [GitHub Advisory DB](https://github.com/advisories), [npm registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md), [GitHub REST API](https://docs.github.com/en/rest)
- **Static Analysis**: [Semgrep Community Edition](https://semgrep.dev/docs/getting-started/) (optional)
- **Authentication**: GitHub OAuth (MVP scope)
- **Hosting**: [Vercel](https://vercel.com/) (frontend + API routes)
- **CLI Companion**: Node.js CLI (npx-runnable)
- **Observability**: Vercel built-in logs

## Status

`deptend.dev` is currently in Phase 0 (Foundation). The initial supported ecosystem is **npm (JavaScript)**. The MVP is capped at a maximum of 3 indexed repositories.
