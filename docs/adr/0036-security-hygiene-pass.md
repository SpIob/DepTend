# ADR 0036 — Security Hygiene Pass: Dependency Patching, Audit Gate, Workflow Permissions

**Status:** Accepted
**Date:** 2026-08-26

> Flipped from Proposed → Accepted on 2026-08-26 (same day as ADR 0037): all four mechanisms shipped in this pass were live-verified — `pnpm audit --prod` reports only the documented `cli` false positive, the audit step runs green in CI, and both workflows execute with their least-privilege permission sets. Flip was trailing housekeeping, not pending work.

---

## Context

A security review of the repo found 20 known vulnerabilities in production dependency trees (1 critical, 9 high): `next-auth@4.24.14` (critical email-normalizer CVE plus OAuth state/PKCE cookie-binding and `getToken()` advisories), `next@15.5.19` (Server-Actions SSRF ×2, Server-Actions DoS, cache confusion), and transitives `postcss@8.4.31`, `nanoid@3.3.15`, `sharp@0.34.5` pulled in by `next`. Separately, both GitHub Actions workflows ran with the default token permission set, and no automated mechanism existed to catch future advisory drift.

## Decision

Three cheap mechanisms, zero new third-party accounts:

1. **Lockfile updates + three pnpm overrides** (root `package.json`): `next` → 15.5.x current, `next-auth` → ≥4.24.15, and `"pnpm.overrides"` forcing `postcss ^8.5.23`, `nanoid ^3.3.18`, `sharp ^0.35.3` past what `next`'s own ranges pin (`next@15.5.24` still declares `postcss 8.4.31`). Overrides are removed once upstream ranges move past the patched floors.
2. **Dependabot** (`.github/dependabot.yml`): weekly npm updates for the pnpm workspace root (minor+patch grouped) plus weekly github-actions updates.
3. **Advisory audit gate in CI**: a `continue-on-error: true` `pnpm audit --prod` step in `ci.yml` — surfaces new high/critical findings in the log without breaking solo-dev CI on every future advisory.

Both workflows get least-privilege `permissions:` blocks (`contents: read`) instead of inheriting the default write-capable token scopes.

## What changed

- `pnpm-lock.yaml`, root `package.json` — version bumps and the overrides block.
- `.github/dependabot.yml` — new.
- `.github/workflows/ci.yml` — job-level `permissions: contents: read`; advisory audit step appended after Test.
- `.github/workflows/ingest.yml` — workflow-level `permissions: contents: read` (checkout plus authenticated public-repo API reads via `github.token` need nothing more).

## Verification

`pnpm audit --prod` drops from 20 findings (1 critical / 9 high / 9 moderate / 1 low) to 1 low — the remaining finding is GHSA-6cpc-mj5c-m9rq, a false positive that matches our own private workspace package literally named `cli` (never published). Full §6 gate run on the pass; see the changelog entry for the same date.

## Consequences

- Overrides pin three transitive versions ahead of upstream declarations — they must be revisited (and dropped) whenever `next` bumps its own floors, or they silently become permanent drift.
- The audit step is advisory by design: it can't fail CI, so it only helps if someone reads the log. If that proves too weak, flip `continue-on-error` off with an allowlist comment for known-accepted findings.
- Dependabot PRs arrive against a solo maintainer's queue — group config keeps volume to roughly one batched PR per week per ecosystem.
