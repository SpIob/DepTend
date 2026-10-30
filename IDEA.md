What it is: DepTend (deptend.vercel.app, repo: github.com/SpIob/DepTend) is a free, zero-budget web dashboard that turns a public GitHub repo's dependency and vulnerability data into a ranked, fully explainable list of "maintenance missions." Unlike a generic vulnerability scanner, it tells a developer what to fix next — each mission is scored by impact, effort, and ecosystem value, with the scoring inputs and weights always visible one click away. No black-box numbers, ever.

Who it's for:

Primary: solo maintainers and small open-source teams (npm/PyPI) who are drowning in Dependabot-style noise, don't know what to prioritize, and can't afford (or don't want) a paid security tool.
Secondary: would-be contributors looking for a high-leverage first issue — DepTend's public "rescue board" turns a maintainer's backlog into something browsable and claimable, closer to a bounty board than a private alert inbox. This is DepTend's most distinctive feature vs. competitors like Dependabot or Snyk.

Core use cases:

A maintainer submits their public repo URL (GitHub OAuth-gated) → DepTend parses the manifest, resolves the dependency tree, queries OSV for advisories, and produces a ranked mission list with impact score, effort label, and plain-language explanation.
Anyone (no login required) browses the public mission board across all indexed repos, filters by severity/effort, and claims an open mission to work on.
A maintainer runs the companion CLI locally (npx-runnable) to get the identical ranked mission list and JSON export, without needing the hosted dashboard at all — a local-first, no-account fallback.

Differentiation: Dependabot lists every CVE with no prioritization. Commercial tools (Snyk, etc.) prioritize but rarely show their math and usually gate features behind a paid tier. DepTend shows the formula, is genuinely free (not freemium), and adds a community-claim layer neither competitor has.

Current state (as of the 2026-10-22 docs pass; the project has since shipped ADRs through 0060, lock-file parsing (ADR 0038), breaking-change signals via GitHub Releases (ADR 0029), and downstream-dependents via libraries.io (ADR 0032)):

Ecosystems supported: npm, PyPI, and Go, auto-detected per repo (no stored ecosystem column — detection runs fresh each ingestion).
Live in production at deptend.vercel.app (the deptend.dev domain itself remains unregistered — a deliberate zero-budget deferral, not a bug).
Repo cap raised to 150 as part of a July 2026 zero-budget launch/marketing push (rate limiting and a mission-copy pass shipped alongside it).
1,100+ automated tests passing; stack is Next.js 15 + Tailwind, Postgres/Neon via Drizzle ORM, GitHub OAuth (next-auth v4), GitHub Actions for cron ingestion, all on free tiers.
Known, disclosed limitation: most missions still show confidence below `high` because at least one scoring input is usually missing in practice — `LIBRARIES_IO_API_KEY` isn't configured for the ingestion workflow (so the downstream-dependents flag stays set), repos without a parseable lock file keep the `no_lock_file` flag, and not every advisory carries a CVSS score. This is surfaced to users, not hidden, per the project's transparency-first principle.

Non-negotiable constraints that shape every decision: zero budget (every tool/service must be free at the tier used), solo-developer-manageable architecture, and transparency-first scoring (no hidden logic, no claim that automation replaces human judgment).
