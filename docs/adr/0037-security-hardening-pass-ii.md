# ADR 0037 — Security Hardening Pass II: Origin Validation, Nonce CSP, URL-Encoding Discipline

**Status:** Accepted
**Date:** 2026-08-26

> Flipped from Proposed → Accepted on the same day: the staged rollout's report-only phase was verified on the deployed site (real-browser check of `/` and `/missions` — every inline script nonce-stamped, zero console errors, zero violation reports), and `CSP_ENFORCED` flipped to true immediately after. Enforced mode was then re-verified live post-deploy.

---

## Context

A full-surface security review of the repo (app routes, core ingestor transport, scripts, workflows, headers) found no high-severity issues — the standing disciplines (parameterized Drizzle queries, guarded single-statement writes, strict charset validation before any URL construction, env-var-routed workflow inputs) held everywhere they applied. It did surface four hardening gaps:

1. **CSRF defense rested on one upstream default.** Every mutating route is session-gated and next-auth v4's session cookie ships `SameSite=Lax`, which already blocks classic cross-site POSTs from carrying the cookie — but no route verified the request's `Origin` itself, so nothing defended in depth against a cookie-config regression or a browser that downgrades SameSite behavior.
2. **No enforced CSP existed.** The previous policy shipped as `Content-Security-Policy-Report-Only` with `script-src 'unsafe-inline'` (next.config.ts), documented there as deferred pending a nonce mechanism. Until enforced, XSS protection rests entirely on React's escaping discipline, and clickjacking protection solely on `X-Frame-Options`.
3. **Two unencoded interpolations into fetch URLs.** The raw.githubusercontent.com base URLs (`manifest-check.ts`, `scripts/ingest.js`) interpolated a repo-controlled `default_branch` verbatim; git permits `%` inside refnames, so a branch literally named `x%2F..%2Fother` was sent raw and decoded server-side into `x/../other` — potentially attributing a different path's manifest to the attacker's own repo row (same host only; never an SSRF). Similarly, Go module paths allowed `..` segments through to proxy.golang.org URLs, where path normalization silently resolves them to a different module than the go.mod line named.
4. **Server `Retry-After` could stall the interactive submission pre-check.** `fetchWithRetry` honored a server's `Retry-After` header up to its own 120 s cap regardless of caller intent, so a 403/429 carrying `Retry-After: 120` (the signature of the shared unauthenticated GitHub budget) would sleep ~2 minutes inside the submitter's POST — contradicting manifest-check's stated 10 s-deadline posture.

## Decision

Four mechanisms, zero new dependencies, zero new accounts:

1. **Origin validation on all eight mutating routes.** New `app/src/lib/request-origin.ts`: `isSameOrigin(request)` compares the `Origin` header's host against `x-forwarded-host`/`Host` (hosts only, never schemes — Vercel terminates TLS at the edge). Present-and-mismatched → 403 before any other gate. Absent Origin → allowed: browsers attach Origin to every POST, so absence means a non-browser client CSRF can't victimize, and curl/CLI testing stays workable. Missing host to compare against fails closed.
2. **Nonce-based CSP middleware** (`app/src/middleware.ts`), **staged**: the middleware generates a per-request nonce, sets the policy on the request headers (how the App Router learns to stamp its own inline bootstrap scripts), and emits it on the response as `Content-Security-Policy-Report-Only`. A single `CSP_ENFORCED` constant flips response delivery to enforced after the deployed site has run this exact nonce-based policy clean of violations. `style-src` keeps `'unsafe-inline'` for now (attribute-level styles unverified); dev mode adds `'unsafe-eval' 'unsafe-inline'` for react-refresh only. No report-uri endpoint — no free account-less reporting service fits the zero-budget constraint; the browser console is the violation surface.
3. **URL-encoding discipline.** New `buildRawContentBase(owner, name, branch)` in `github-meta.ts` percent-encodes each slash-separated segment (branch refs may legitimately contain `/`), used by both `manifest-check.ts` and `scripts/ingest.js`. `go-parse.ts`'s validator additionally rejects bare-dot (`.`/`..`) path segments — single dots inside segments (domain-style paths) unaffected. Defense-in-depth href encoding for GitHub profile links in `mission-card.tsx` and the repo page (owner/name are charset-validated at submission; this guards against future ingestion changes).
4. **Caller-bounded Retry-After.** `FetchRetryOptions.maxRetryAfterMs` caps how long a server's Retry-After may delay the retry (default unchanged at 120 s for background ingestion). The submission pre-check passes 2 s, matching its own backoff.

Also in this pass: deprecated `X-XSS-Protection` dropped; `--repo-url`'s cap-bypass nature documented as an operator-only invariant at its use site.

## What changed

- `app/src/lib/request-origin.ts` (+ test) — new origin gate.
- All eight mutating route files (+ colocated test suites) — gate wired first-in-handler; suites send same-origin Origin+Host on every request and add a cross-origin 403 case.
- `app/src/middleware.ts` — new; owns the CSP end-to-end.
- `app/next.config.ts` — Report-Only CSP block removed (owned by middleware now); `X-XSS-Protection` removed.
- `packages/core/src/ingestor/github-meta.ts` (+ test) — `buildRawContentBase`.
- `packages/core/src/ingestor/manifest-check.ts`, `scripts/ingest.js` — encoded raw base; pre-check transport gains `maxRetryAfterMs`.
- `packages/core/src/ingestor/go-parse.ts` (+ test) — dot-segment rejection.
- `packages/core/src/ingestor/fetch-retry.ts` (+ test) — `maxRetryAfterMs` option.
- `app/src/components/mission-card.tsx`, `app/src/app/repo/[owner]/[name]/page.tsx` — encoded profile hrefs.

## Verification

Full §6 gate (typecheck · test · clean build · lint `--max-warnings 0` · format:check · both `tsconfig.eslint.json` passes). Route-level suites exercise both origin-gate paths; fetch-retry tests pin the capped and default Retry-After windows via fake timers; github-meta/go-parse tests pin the new encoding/validation.

The CSP flip to enforced is deliberately NOT part of this pass's acceptance: per §6's live-infrastructure lesson, mock coverage proves wiring, not production behavior. This ADR flips to Accepted once the deployed site has served the report-only nonce policy clean of script/style violations (checked in real browsers against `/` and `/missions`).

## Consequences

- One rollout step remains: set `CSP_ENFORCED = true` in `app/src/middleware.ts` after the report-only soak. Any future inline script introduced without going through the nonce flow will break loudly at that point — that is the intended failure mode.
- Middleware makes every route dynamically rendered; all pages were already `force-dynamic`, so nothing static is lost today. A future static page would silently become dynamic — worth remembering if page-render costs ever matter.
- `buildRawContentBase` changes the wire format of raw-content URLs for exotic refnames only; ordinary branches produce byte-identical URLs, and detectEcosystem's probing is unaffected otherwise.
- The origin gate trusts `x-forwarded-host` over `Host` because Vercel sets it authoritatively; a deployment elsewhere must keep that proxy contract, or the check degrades to plain-Host comparison.
