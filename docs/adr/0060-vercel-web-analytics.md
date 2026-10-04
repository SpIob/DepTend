# ADR 0060: Vercel Web Analytics

Date: 2026-10-04
Status: Proposed

## Context

The dashboard has no audience-level analytics. What exists today (ADR 0052's
`Server-Timing` header and the per-request timing store in
`app/src/lib/timing/`) measures request performance server-side only; nothing
measures whether people visit, which pages they use, or from where. Every
prior option for closing that gap conflicted with at least one of §1's
non-negotiable constraints:

- **Self-hosted analytics** (umami, Plausible CE) needs a server to run —
  conflicts with zero-budget (a second always-on host) and solo-dev ops
  burden simultaneously.
- **GA4 / third-party trackers** need a cross-origin script — blocked by the
  nonce-based CSP (ADR 0037) and in tension with the §1
  transparency-first / opt-in posture and the H1 header hardening
  (`Referrer-Policy: no-referrer`) already shipped.

Vercel Web Analytics is first-party to the hosting the project already pays
nothing for. It runs on the existing Hobby plan within a free monthly event
allowance and requires no third-party script origin.

## Decision

1. **`@vercel/analytics@^2.0.1`** added to `app/package.json`'s
   `dependencies` block (one dependency; MIT; peer-compatible with
   `next@15.5.24` and `react@19.2.7`). Installed with **pnpm** (`pnpm --filter
@deptend/app add`), not npm — `app` is a pnpm-workspace member and an npm
   install would fork `node_modules` and the lockfile.
2. **`<Analytics />`** imported from **`@vercel/analytics/next`** (the App
   Router import — the generic `@vercel/analytics/react` path is the
   non-Next fallback) and rendered in `app/src/app/layout.tsx` immediately
   after `<Providers>`, so every route is covered by one mount point.
3. **Enablement is a Vercel-side action** (dashboard toggle or
   `vercel project web-analytics`); the component renders inertly until the
   feature is enabled for the project. No env var is required.

**CSP: no policy change needed.** The Analytics script is served same-origin
(`/_vercel/insights/script.js`) and reports to a Vercel first-party endpoint,
both covered by the existing `script-src 'self' 'nonce-…'` /
`connect-src 'self'` (ADR 0037). Verified on a local production build: the
script tag is nonce-stamped like every other inline script.

**Zero-budget check (§1):** Hobby includes **50,000 events/month** (per
vercel.com/docs/analytics/limits-and-pricing; supersedes the 2,500/month
figure from the GA announcement), no credit card, and exceeding the allowance
**pauses collection** (after a 3-day grace period) rather than billing —
Vercel emails before the limit. DepTend's traffic (a public solo dashboard)
is far inside that; if it ever isn't, the decision point is upgrade-or-remove,
flagged to Mico, not a silent bill.

## Alternatives considered

- **Self-hosted umami/Plausible**: rejected above (server + ops burden).
- **GA4**: rejected (cross-origin script under a nonce CSP; privacy posture).
- **Plausible/Cloudflare Analytics SaaS**: paid or account-with-extra-terms;
  no free tier that fits.
- ** Doing nothing**: the status quo; `Server-Timing` covers performance but
  not audience. The user (Mico) asked for analytics explicitly, so this ADR
  records the decision rather than deferring it.

## Consequences

- One new dependency in `app/package.json` only; no workspace-declaration
  change (ADR 0044's dual-block rule applies to packages `core` uses, and
  core does not use this).
- First Load JS on `/` is 117 kB with the loader included; full production
  build green across all 20 routes (see verification).
- Data collected is page views + referrer (no cookies, no persistent user
  identifiers at the Hobby tier) — consistent with §1; no cookie banner or
  consent gate is introduced by this change.
- The `Referrer-Policy: no-referrer` header (H1 hardening) applies to
  outbound navigation; Vercel Analytics reads `document.referrer` in-page,
  which that header does not scrub — referrer data still reaches Vercel.

## Verification

Standard gate (§6), run 2026-10-04 after the changes:

1. `pnpm run typecheck` — all workspaces green (incl. `typecheck:tests`).
2. `pnpm run test` — 1,168 passed (app 227, core 790, cli 113, scripts 38).
3. Clean `pnpm run build` (every `dist`/`.next` removed first) — green, all
   20 routes compiled.
4. `pnpm run lint` (`--max-warnings 0`) — green.
5. `pnpm exec prettier --check` on touched files — green.

Live verification **pending** (this ADR stays `Proposed` until it lands):

- Merge + deploy, then confirm `deptend.vercel.app` serves the Analytics
  script (`/_vercel/insights/script.js`) with the request's nonce.
- Enable Web Analytics for the project (dashboard or
  `vercel project web-analytics`), visit the site, then confirm events
  arrive (`count_pageviews` via Vercel MCP or the dashboard).
