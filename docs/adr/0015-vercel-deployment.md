# ADR 0015 — Vercel Deployment: Build Ordering, OAuth Callback Host Binding, and the Domain Decision

**Status:** Accepted
**Date:** 2026-07-11
**Phase:** 3 (first production deployment)

---

## Context

Four things surfaced while Mico brought up the real Vercel production deployment — three bugs, one settled project decision. Same "found via real usage, not any of the five standard checks" pattern as ADR 0014, and for the same structural reason: none of `typecheck`/`test`/`build`/`lint`/`format:check` run against Vercel's actual build pipeline or a live OAuth round-trip. Mico diagnosed and fixed all three bugs directly.

### 1. Vercel build failed: `@deptend/core` never got compiled

`packages/core/dist/` is gitignored (correctly — it's build output). ADR 0014 added a `prebuild` hook to `app/package.json` on the theory that Vercel would invoke `app`'s own `build` script, triggering `prebuild` first via npm/pnpm's standard lifecycle. That theory was wrong for Vercel specifically: with a detected Next.js framework preset and a default Build Command, Vercel's build step doesn't necessarily go through `pnpm run build` (which would respect `prebuild`) — it can invoke the framework's build tool more directly, bypassing package.json's script lifecycle. Confirmed in the build log: only `@deptend/app@0.0.1 build` executed, never `@deptend/core@0.0.1 build`.

The `postinstall` hook doesn't have this problem, because it isn't tied to _how_ the build step gets invoked — it's tied to `pnpm install`, which Vercel always runs, unconditionally, as a separate step before any build step regardless of framework preset.

### 2. `GH_CLIENT_ID` was simply never added to Vercel

Not a scoping issue, not a typo — the variable was absent. An operational miss during the "add all environment variables" step, not a code or architecture problem. Included here for the record, not because it needed a fix beyond adding it.

### 3. OAuth `redirect_uri` mismatch — next-auth v4 builds the callback URL from the request's `Host` header, not from `NEXTAUTH_URL`

After swapping in the correct production OAuth app credentials, sign-in still failed. Decoding the actual `redirect_uri` GitHub received showed it wasn't the stable `deptend.vercel.app` domain registered on the OAuth app — it was whatever per-deployment hash URL (`deptend-<random>-antigen.vercel.app`) happened to be open in the browser at the time.

This is next-auth v4's actual behavior on Vercel, not a misconfiguration: the callback URL is derived from the incoming request's `Host`/`X-Forwarded-Host` header so that preview deployments — which each get a unique, unpredictable URL — can round-trip an OAuth flow back to whichever host initiated it, rather than hardcoding one URL that would break every preview deployment. The tradeoff: a GitHub OAuth app can only have one registered callback URL, so OAuth only actually works when the flow is initiated from that exact host. Not fixable in code without giving up the preview-deployment round-trip behavior; fixed operationally instead.

### 4. The domain decision

`deptend.dev` remains unregistered (confirmed via ICANN WHOIS, 2026-07-11). Registering it is a real ongoing cost (~$5–13/year depending on registrar), which sits uneasily against "every tool, service, and dependency must be completely free at the required usage tier" even though it's a one-time-per-year cost rather than a service subscription, and even though the project's own name has assumed the domain would eventually exist since Phase 0.

**Decision (Mico): defer indefinitely.** `deptend.vercel.app` is the project's domain through Phase 6+, not a placeholder — `deptend.dev` gets registered and attached only once budget allows, with no re-litigation needed before then. Phase 3's project-plan exit criterion ("Next.js frontend live on Vercel **at deptend.dev**") is satisfied in spirit by the stable Vercel domain; the literal domain name in that sentence was never the load-bearing part of the requirement.

## Decision

- Root `package.json`: added `"postinstall": "pnpm --filter @deptend/core build"`. Verified by deleting `packages/core/dist` and confirming `pnpm install` alone (no build step) rebuilds it via the `postinstall` banner firing.
- `app/package.json`'s `prebuild`/`predev` hooks (ADR 0014) are **not removed** — they still matter for local dev, where a developer can edit `packages/core/src` without re-running `pnpm install` at all. `postinstall` and `prebuild`/`predev` cover different triggers (after install vs. before every dev/build invocation) and are complementary, not redundant. An explicit inline chain in `app/package.json`'s `build` script itself (suggested as an optional third layer) was considered and skipped — two independent, verified mechanisms already cover every path this project actually exercises (Vercel via `postinstall`; local `dev`/`build` via `predev`/`prebuild`), and a third layer doing the same job wouldn't close any gap the other two leave open.
- No code change for the OAuth callback behavior. Operational rule instead: **OAuth sign-in must be tested from the stable production URL, typed directly into the address bar** — never from a Vercel-generated per-deployment link, which will always fail with a `redirect_uri` mismatch regardless of how correctly everything else is configured. Worth remembering this applies to Preview deployments generally, not just this one incident: sign-in will never work there by design, but the mission list itself (no auth required) renders fine.
- `deptend.vercel.app` recorded as the settled, permanent Phase 3+ domain. `deptend.dev` remains a future, budget-permitting upgrade, not a Phase 3 blocker.

## Consequences

- Verified independently: `postinstall` firing (deleted `dist/`, ran `pnpm install`, confirmed the rebuild). Not independently verified from here: the actual Vercel build/deploy or the live OAuth round-trip — both confirmed working only by Mico's own report against real infrastructure this project's sandbox can't reach.
- `NEXTAUTH_URL` is still worth setting correctly (Production environment, matching the real domain) even though it isn't what determines the OAuth `redirect_uri` on Vercel — it's still used elsewhere in next-auth (e.g., absolute URLs in email flows, if ever added; some internal CSRF/cookie handling). Not redundant, just not the fix for this particular symptom.
- Same lesson as ADR 0012 and 0014, now at a third layer: this project's five standard checks, even combined with everything ADR 0012/0014 already closed, still can't reach Vercel's specific build-invocation mechanics or a live multi-domain OAuth round-trip. Each of the three deployment platforms this project touches (local machine, GitHub Actions, Vercel) has turned out to have its own way of invoking scripts that isn't identical to the other two — something to keep in mind before assuming a fix verified on one of them generalizes to another.

## Free-tier compliance

No new dependency, no new service, no new cost from the technical fixes. The domain decision is explicitly the zero-budget-compliant choice — deferring a real cost rather than incurring it.
