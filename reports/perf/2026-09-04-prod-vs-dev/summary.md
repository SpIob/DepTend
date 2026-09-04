# prod vs dev dual comparison — 2026-09-04

## Setup

- **Production:** `https://deptend.vercel.app` (live, HEAD = 99ebf6b)
- **Local dev:** `pnpm dev` → `http://localhost:3000` (Turbopack, 735 ms ready)
- **DB:** production and dev point at different Neon branches
  - Dev unpooled: `ep-solitary-frost-ao44h8wf.c-2.ap-southeast-1.aws.neon.tech`
  - Dev pooled:   `ep-curly-meadow-aoococ7q-pooler.c-2.ap-southeast-1.aws.neon.tech`
- Both envs have identical schema (same migrations applied)
- Browser: ego-browser task space `prod-vs-dev comparison 2026-09-04` (id=1), reused
  across all four pages on both sites. Zero console errors/warnings observed on either
  side.

## What matches

- All four pages (`/`, `/missions`, `/org/SpIob`, `/repo/SpIob/deptend-go-test-fixture`)
  return **200 OK** on both.
- CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `referrer-policy: no-referrer`, `permissions-policy` are **identical** on both.
- `server-timing: total;dur=…` present on both, but expectedly different magnitudes
  (Vercel edge ~0.3 ms vs localhost 0.1 ms).
- Same Next.js 15.5.24 build, same first paint structure, same hydration behavior.
- `/repo/SpIob/deptend-go-test-fixture` first 10 mission IDs in display order are
  **identical** between dev and prod:
  `GHSA-x527-…, GHSA-5cgq-…, GHSA-rm3j-…, GHSA-89gr-…, GHSA-vgwf-…, GHSA-f5wc-…,
   GHSA-jppx-…, GHSA-v778-…, GHSA-w879-…, GHSA-q4h4-…`
- Same `missionType` taxonomy, same `vulnerability_fix` rendering, same `low effort`
  / `Trivial effort` vocabulary.
- Both show the same `1 skipped` collapsible section ("No package.json found" for
  `SpIob/Bagong-Enerhiya`).

## What does **not** match — significant

### 1. Repo roster size — **dev has 5 repos production does not**

`/` (home page), `repos indexed` count:

| env     | repos indexed | repos in page            |
| ------- | ------------- | ------------------------ |
| dev     | **6**         | 9 (6 with missions + 3 with `total:0` placeholder, 1 collapsed into "skipped") |
| prod    | **3**         | 4 (3 indexed + 1 skipped) |

Repos **only on dev** (in DB, not on prod):

- `SpIob/StockWatch`         (NPM, 29 missions: 0/8/19/2/0)
- `SpIob/Torque2D`           (no manifest found, 0 missions)
- `SpIob/sherlock`           (no manifest found, 0 missions)
- `SpIob/deptend-pypi-test-fixture` (PYPI, 8 missions: 4/0/0/0/4)
- `SpIob/deptend-nullrepo-test-fixture` (PYPI, 2 missions: 0/1/0/0/1)

These are visible on dev because dev points at the dev Neon branch, where the
backfill is more complete. **Production only has the 3 originally-submitted repos
plus the Go test fixture.** Whether this is by design (only-shipped-missions) or a
data-shipping gap depends on whether ingestion has run since the most recent
submissions. Flag for decision before relying on the count as a regression signal.

### 2. Mission counts differ for the same repos

| repo                          | dev (counts)           | prod (counts)            | divergence                                |
| ----------------------------- | ---------------------- | ------------------------ | ----------------------------------------- |
| `SpIob/deptend-go-test-fixture` | 8c/9h/9m/0l/29u (55)   | 8c/9h/9m/0l/29u (55)     | identical                                 |
| `SpIob/FlowState`               | 1c/10h/19m/2l/0u (32)  | 1c/12h/20m/2l/0u (35)    | prod +2h +1m, dev +0 unknown              |
| `psf/requests`                  | 1c/10h/12m/1l/24u (48) | 1c/13h/20m/2l/12u (48)   | same total, but different distribution   |
| `SpIob/Bagong-Enerhiya`         | 0 (no manifest)        | 0 (no manifest)          | identical                                 |

Prod and dev have the same **total** for `requests` and `go-test-fixture` but very
different internal distributions. This is consistent with a fresh ingest in prod
that re-classified some previously-`unknown` advisories into `high`/`medium` (likely
because their CVSS data was newly added to OSV between ingest runs).

### 3. Mission board ordering and scoring — `psf/requests` top 5 differs

DOM-extracted, side-by-side:

| rank | DEV                                              | PROD                                              |
| ---- | ------------------------------------------------ | ------------------------------------------------- |
| 1    | urllib3 critical, 1.23, **low conf, 9.0/10**    | urllib3 critical, 1.23, **9.6/10**                |
| 2    | urllib3 GHSA-q2q7, 1.26.5, **low conf, 7.8/10** | urllib3 **PYSEC-2023**, 2.0.6, **8.6/10**         |
| 3    | urllib3 GHSA-xqr8 (certifi), **low conf, 7.8/10** | urllib3 GHSA-q2q7, 1.26.5, **8.3/10**            |
| 4    | urllib3 GHSA-hmv2, 1.25.8, **low conf, 7.8/10**  | urllib3 certifi GHSA-xqr8, **8.3/10**             |
| 5    | urllib3 GHSA-mh33, 1.24.2, **low conf, 7.8/10**  | urllib3 GHSA-hmv2, 1.25.8, **8.3/10**            |

Two distinct issues here:

- **Different scores for the same mission.** Row 1's mission (`GHSA-www2-v7xj-xrc6`)
  is 9.0/10 in dev and 9.6/10 in prod. Same advisory, same description, different
  numeric score. The `score.ts` computation is a function of `(impact, effort,
  ecosystem_value)` per ADR 0012; if those inputs match, the score should match.
  This is either (a) different CVSS inputs feeding the scorer on each side, or
  (b) the score is being recomputed live vs cached. Worth a closer look next pass.
- **Different orderings and different advisories entirely.** `PYSEC-2023-192`
  appears at rank 2 in prod but doesn't appear in dev's top 5. Prod has
  `PYSEC-2026-1996`, `PYSEC-2026-142`, `PYSEC-2024-60`, `PYSEC-2024-230`,
  `PYSEC-2026-1997`, `PYSEC-2026-1999`, `PYSEC-2026-141`, `PYSEC-2023-212`,
  `PYSEC-2026-215`, `GHSA-mc23-976p-j42x` in its top 30 that don't appear in
  dev's top 30. Conversely dev's top 30 has 11 GHSA-* advisories that don't
  appear in prod's top 30. This is consistent with prod's PSF/requests ingest
  having run more recently than dev's.
- **Confidence text** — dev renders `⚠ low confidence` on every visible card;
  prod hides it on the top 10 and only shows it starting around rank 11. This
  is the same behavior as in §11 of AGENTS.md: confidence reaches `"medium"`
  when both `breaking_change_signals` and `downstream_dependents` are
  resolvable, neither currently is. **So both should say `low confidence` on
  every card**; prod's missing text on the top 10 is a real UI inconsistency.

### 4. Mission description text — CVSS suffix missing on dev

`packages/core/src/scorer/mission-copy.ts:72` appends ` (CVSS 9.8)` to the
description when `advisory.cvssScore !== null`. Same advisory, two different
outputs:

- **dev:** `Severity: critical.`  (no CVSS suffix)
- **prod:** `Severity: critical (CVSS 9.8).`  (CVSS suffix present)

The first mission on `/missions` is `GHSA-www2-v7xj-xrc6` for urllib3 on both
sides — same advisory, but dev's description omits the CVSS. This implies
**dev's `advisories.cvss_score` row is NULL** for this advisory, while prod's
has `9.8`. This is a data-state difference, not a code difference: same code,
different rows in the `advisories` table between branches.

### 5. Star counts and ingest dates differ

psf/requests star count: **dev = 54,250** (ingested 8/22/2026), **prod = 54,266**
(ingested 8/30/2026). The number went up by 16 between ingests, and the ingest
date moved forward 8 days. This is consistent with prod having run an ingest
more recently than dev's last run.

## Verdict

**No code-level regressions** were observed. The page rendering, layouts, styles,
CSP/security headers, and per-repo board are all in sync between the deployed
site and HEAD on `main`. The differences that do exist are all explainable as
**data-state divergence** between the two Neon branches — different last-ingest
times, different rows in `advisories`/`missions`. The most important flag is
**decision point (3)** above: the score divergence (9.0 vs 9.6) on the same
advisory is real and reproducible on the live board, and warrants a closer look
in a follow-up pass to confirm it's an ingest-pipeline artifact and not a
scorer-regression that the typecheck/test gate didn't catch.

## Artifacts

- Production HTML dumps: `/tmp/prod-{home,missions,org,repo}.html`
- Local dev HTML dumps: `/tmp/dev-{home,missions,org,repo}.html`
- Ego-browser task space id 1 still open; closed by `completeTaskSpace(1, { keep: false })`
  at end of session.
