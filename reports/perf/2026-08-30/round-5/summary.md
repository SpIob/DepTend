# Round 5: `/org/[org]` cold + warm — anonymous

**Date:** 2026-08-30
**Goal:** Characterize `/org/[org]` performance and verify the ADR 0047 fix that ended the "permanent loading skeleton" era (AGENTS.md §13).

**Method:**

- Test orgs: `SpIob` (owns 3 of 4 repos in the directory per the home page) and `psf` (owns 1 of 4).
- Lighthouse cold + warm x3 for each.
- 10x `curl` probes for each; also one probe of a guaranteed-nonexistent org (`/org/nonexistent-zzz`) for control.
- ego-browser visual check to confirm whether the page actually renders a directory or a 404.

## Critical finding: every `/org/[org]` URL serves a 404 body

**This round discovered a regression that AGENTS.md §13's 2026-08-23 audit didn't catch.** The page returns HTTP 200 from the Vercel edge (because `notFound()` in Next.js produces a 200 with the 404 HTML when used this way) but the rendered content is:

> "404 — not found
> That page doesn't exist. It may have been a mistyped repo path, or a mission that has since been resolved."

— confirmed via ego-browser `document.body.innerText` extraction.

This affects:
- `/org/SpIob` — the org that owns 3 of 4 repos on `/`
- `/org/psf` — the org that owns 1 of 4 repos
- `/org/<any string>` — even `/org/nonexistent-zzz` returns the same 404 body

The 4 repos on the home page all have `org_id` set (the home directory renders them), but the `organizations` table has no row whose `github_login` matches `SpIob` or `psf`. Per `packages/core/src/db/queries.ts:742-749`, `getRepoDirectoryBase({ orgLogin })` looks up `organizations.githubLogin` → `organizations.id`; if the org row doesn't exist, it returns `[]` early. Per `app/src/app/org/[org]/page.tsx:41`, the page then calls `notFound()` because `getOrganizationByLogin` returned null.

Two likely causes (in order of probability):

1. **The `scripts/backfill-orgs.mjs` script (ADR 0047's one-time backfill) has not been run against production.** AGENTS.md §2 mentions it exists "for pre-existing rows" but doesn't say whether it's been run in prod. With only 4 repos in the prod database, the backfill would have to be tiny — seconds of work, and yet the data isn't there.
2. **The new ingestion pipeline (`lookupGitHubOwnerMeta` in `packages/core/src/ingestor/github-org-meta.ts`) isn't writing to the `organizations` table for newly-ingested repos.** Possible if the pipeline was updated but the `ingest.yml` cron hasn't run yet, or the writer code path silently failed.

The first is more likely; the second is a stronger claim that would need production logs to confirm. Either way, this is a real bug for users: a directory link from `/` to `/org/SpIob` (which the home page encourages via the directory structure) lands on a 404. **The 4-repo dataset is too small to surface this in a unit test, which is probably how it slipped through.**

This is exactly the pattern AGENTS.md §0.1 warns about: "Phase-status docs, ADRs, and comments in this repo have drifted from reality multiple times". AGENTS.md §13 reads as if `/org/[org]` is fully working; in fact it 404s for every currently-known org.

## Lighthouse metrics

| Run | FCP | LCP | TBT | CLS | Doc TTFB (LH) | Perf score | Page bytes |
|---|---|---|---|---|---|---|---|
| `/org/SpIob` cold | 0.4 s | 0.7 s | 50 ms | 0.038 | 40 ms | 100/100 | 137 KiB |
| `/org/SpIob` warm-1 | 0.3 s | 0.6 s | 30 ms | 0.038 | 40 ms | 100/100 | 138 KiB |
| `/org/SpIob` warm-2 | 0.4 s | 0.8 s | 20 ms | 0.038 | 40 ms | 99/100 | 137 KiB |
| `/org/SpIob` warm-3 | 0.4 s | 0.6 s | 40 ms | 0.038 | 50 ms | 100/100 | 138 KiB |
| `/org/psf` cold | 0.4 s | 0.6 s | 20 ms | 0.038 | 40 ms | 100/100 | 137 KiB |
| `/org/psf` warm-1 | 0.4 s | 0.6 s | 30 ms | 0.038 | 40 ms | 100/100 | 138 KiB |
| `/org/psf` warm-2 | 0.4 s | 0.6 s | 20 ms | 0.038 | 40 ms | 100/100 | 137 KiB |
| `/org/psf` warm-3 | 0.4 s | 0.6 s | 30 ms | 0.038 | 40 ms | 100/100 | 137 KiB |

The numbers are *the same as the Round 1 baseline for `/org/SpIob`* (FCP 0.4 s, LCP 0.8 s, TBT 40 ms, CLS 0.038) because the 404 page is what's being measured in both rounds. The page is fast *because it doesn't render the org directory*. If the org page actually rendered a directory of 3 repos, the TBT and bytes would be higher (compare to `/`: 30 ms TBT, 141 KiB).

## curl TTFB probes (10 iters each)

| URL | Median TTFB | TTFB range | Median total | Median bytes |
|---|---|---|---|---|
| `/org/SpIob` (404 body) | 187 ms | 173-231 ms | 195 ms | 15 525 |
| `/org/psf` (404 body) | 188 ms | 171-211 ms | 195 ms | 15 515 |
| `/org/nonexistent-zzz` (control) | 192 ms | 179-217 ms | 195 ms | 15 588 |

All three are statistically identical: 187-192 ms median TTFB, 195 ms total, 15.5 KiB. This is consistent with the same 404 page being served in all three cases — the server work is "look up org, find nothing, render 404 page", which is the same regardless of input.

## Observations

1. **The org page is a 404 in production today.** The 4 repos on `/` all link to orgs that don't exist in the `organizations` table. This is a real bug, not a measurement artifact.

2. **Performance is "fast" because the page is empty.** LCP 0.6-0.8 s, TBT 20-50 ms, 137 KiB. A populated org page would render the same header chrome plus a grid of `RepoCard` components, which based on `/` would add ~3-5 ms TBT and ~4 KiB. The current 137 KiB / 50 ms is a lower bound, not a real measurement of the directory path.

3. **No `notFound()`-as-404 in HTTP status.** Vercel serves HTTP 200 for the 404 body, which is the documented Next.js behavior when `notFound()` is called inside a Server Component. The status code from `curl` is 200 for every `/org/*` URL. The lighthouse "Initial server response time was short" audit doesn't notice because TTFB is fine.

4. **No regressions in the warm-cache path.** Even with the 404, the warm TTFB and Lighthouse metrics are within noise of cold. The `unstable_cache` 60 s TTL on `getOrganizationByLogin` is working as designed (a no-op when the lookup returns null, but the cache is still consulted).

5. **The 404 page itself is fast and well-built.** 15.5 KiB, 195 ms total, the "Browse repos / All missions" links are rendered, the layout chrome is intact. The page is doing its job *as a 404*; the issue is that it's a 404 instead of a directory.

## What this round recommends

- **Confirm whether `scripts/backfill-orgs.mjs` has been run against the production database.** It is a one-time idempotent operation that would resolve the missing `organizations` rows for all 4 currently-tracked repos. Per `scripts/backfill-orgs.mjs:22-25`, it needs `GITHUB_TOKEN` to be set on the runner for authenticated rate limits; unauthenticated it caps at ~24 orgs/minute, but with 2 orgs (SpIob, psf) to backfill that's 5 seconds. **Flagged as a decision point: should the backfill be run now?**
- **If the backfill has already been run and the issue persists, check the writer path** (`packages/core/src/ingestor/writer.ts`'s `upsertOrganization` and `repos.orgId` setter) for whether it's actually writing the `organizations` rows it claims to. A SQL `SELECT * FROM organizations LIMIT 10;` against the production database would answer this immediately.
- **Once the data is in place, re-run Round 5** to characterize the actual directory page performance, not the 404 placeholder. The 137 KiB / 50 ms TBT / 0.6-0.8 s LCP numbers are a lower bound; the real page will be a few ms slower and a few KiB larger, but still well under any perf threshold.

## What's coming

- The final `compare.md` aggregating all 5 rounds.
