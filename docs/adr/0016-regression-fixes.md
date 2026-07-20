# ADR 0016 — Regression Fixes: `predev`/`prebuild` Hooks Restored, Duplicate Ingestion Step Removed

**Status:** Accepted
**Date:** 2026-07-14
**Phase:** 3 → 4 transition (found before Phase 4 work began)

---

## Context

Both bugs in this ADR were found by a direct structural audit of the actual repo contents against `Phase3_Status.md` and ADRs 0014/0015 — not by live usage, which is how every prior retroactive fix in this project (ADR 0009, 0010, 0012, 0014, 0015) was found. That's a new discovery pattern worth naming: this project's five standard checks (`typecheck`/`test`/`build`/`lint`/`format:check`) can't catch either of these, but neither can "try using the feature" — both are regressions of fixes that were already built and verified once. Only a diff against what was previously documented as working caught them.

### 1. `app/package.json` lost its `predev` hook

ADR 0014 added `"predev": "pnpm --filter @deptend/core build"` to `app/package.json` and verified it live (deleting `dist/`, watching `pnpm --filter app dev` rebuild core before `next dev` started). ADR 0015 explicitly states this hook "is not removed" when adding `postinstall`. But the file as of this audit has no `predev` at all — `build` instead inlined `pnpm --filter @deptend/core build && next build` directly, which ADR 0015 says was "considered and skipped" in favor of keeping `predev`/`prebuild` as the mechanism. Net effect: `pnpm --filter app dev` after editing `packages/core/src` is unprotected against a stale `dist` again — the exact failure mode ADR 0014 closed.

How the inline chain got there instead of the documented hooks isn't known — not attributable to any specific step in this project's history, just caught by comparing current state to prior documentation.

### 2. `.github/workflows/ingest.yml` had a duplicated `Run ingestion` step

Two steps named "Run ingestion" existed in sequence: the first hardcoded `--triggered-by manual` whenever `repo_id` was set, ignoring the real `inputs.triggered_by` value entirely; a `Report failure` step sat in between; then a second, correct "Run ingestion" step properly forwarded `--triggered-by "${{ inputs.triggered_by }}"`. ADR 0014's own text states its sandbox copy "already had this exact change from ADR 0013's original delivery" with no duplication — so the duplicate was introduced sometime after ADR 0014, undocumented.

Net effect before this fix: `scripts/ingest.js` ran **twice** on every trigger.

- Nightly cron (`repo_id` unset): both steps fall through to `--triggered-by cron` — the whole pipeline ran twice against every pending repo, every night.
- Repo submission (`repo_id` set, via `triggerIngestion()` in `app/src/lib/github-dispatch.ts`, which sends `triggered_by: "submit"`): first step ran with `--triggered-by manual` (wrong label), second ran correctly with `--triggered-by submit` — two full ingestion passes per submission, likely two `ingestion_runs` rows, and doubled OSV/npm/GitHub API calls.

## Decisions

### `app/package.json`

Restored to the ADR 0014/0015 design rather than inventing a new pattern, since that design was already built and verified once:

```json
"scripts": {
  "predev": "pnpm --filter @deptend/core build",
  "dev": "next dev --turbopack",
  "prebuild": "pnpm --filter @deptend/core build",
  "build": "next build",
  "start": "next start",
  "typecheck": "tsc --noEmit"
}
```

`build` reverts to plain `next build` — `prebuild` covers the core rebuild via pnpm's automatic `pre*` lifecycle, so the inline chain was redundant with the hook it replaced, not an improvement on it.

### `.github/workflows/ingest.yml`

Removed the first (stale, mislabeling) "Run ingestion" step entirely. One step remains, correctly forwarding `inputs.triggered_by` in the `repo_id`-present branch and `cron` otherwise, followed by the existing `Report failure` step.

## Consequences

- Neither fix has been applied to the live repo or re-verified by Mico yet — this ADR is `Proposed`, not `Accepted`, pending that.
- `predev`/`prebuild` restoration: verifiable via Mico's standard 5-check loop plus the same live check ADR 0014 used (delete `packages/core/dist`, run `pnpm --filter app dev`, confirm the core build completes before `next dev` starts).
- `ingest.yml` fix: per ADR 0014's operational lesson, this workflow file change must be pushed to `main` before testing a `workflow_dispatch` call against it — GitHub validates dispatch calls against the server-side copy, not local files. Confirming this fix requires either a real submission (repo_id path) or waiting for/manually triggering a cron run, then checking the Actions tab for exactly one "Run ingestion" execution and one `ingestion_runs` row.
- Worth a quick check of `ingestion_runs` for any rows already created by the duplicate-step period — if double-run rows exist from real cron nights or real submissions since Phase 3 closed, they're harmless (upserts are idempotent per Phase 1/2 design) but worth knowing about for accurate history, not urgent to clean up.

## Free-tier compliance

No new dependency, no new service. If anything, this fix reduces GitHub Actions minutes and external API call volume (OSV/npm/GitHub) back to one pass per trigger instead of two — a small win for the free-tier ceiling, not a cost.
