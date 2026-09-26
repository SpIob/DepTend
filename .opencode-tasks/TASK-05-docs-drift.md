# TASK-05 — Docs-drift repair: AGENTS.md §13 and the stale status claims

**Agent:** opencode · **Priority:** medium (no code behavior change, but the repo's own
§0.1 rule makes stale docs a real hazard for the next agent)
**Area:** `AGENTS.md` (§2, §5, §13), `docs/adr/0058-ci-cd-pipeline-hardening.md` (status
flip), `docs/adr/0054-2026-09-05-audit-fixes.md` (status flip), `CHANGELOG.md` (nothing
to add unless a fix above landed)

## Evidence (verified live, 2026-09-25, commit 07e5435 deployed)

Four stale claims in AGENTS.md §13 (and siblings), each verified against real
infrastructure this pass — the evidence exists, so the flips/updates are mechanical:

1. **"Production still needs `drizzle-kit migrate` for `0005`"** — STALE/CLOSED.
   Verified via Neon MCP against production (branch `production`,
   `br-square-hill-aovhsm68`): all 8 migrations 0001–0008 are registered, and every
   hash matches the local files exactly, including 0005 (`idx_dependencies_repo_ecosystem`).
   Update §13: strike the item as closed with the verification evidence.
2. **"`GITHUB_TOKEN` is absent in production (Vercel)"** — STALE. Verified via Vercel
   MCP (`filter_project_envs` on `deptend`): `GITHUB_TOKEN` IS present, target
   `[production]`, secret visibility, set by `workitallman-2267`. The submission
   manifest pre-check therefore runs authenticated. Update §5's row and §13's item.
3. **ADR 0054 still `Proposed` ("live verification happens on the next deploy window")**
   — VERIFIED, flip to Accepted. The site runs 07e5435 (confirmed via the Lighthouse
   run's checkout log, 2026-09-25) and the live checks passed:
   - `/api/bogus-path-test` → HTTP 404 + `{"error":"Not found."}` JSON envelope (the
     catch-all fix).
   - `/missions?page=999` → HTTP 200 with a full 27.9 kB board (the clamp fix renders
     the last page; no empty flash).
   - `/repo/SpIob/deptend-go-test-fixture` → HTTP 200, and the per-repo bookmark
     toggle's `aria-label="Sign in with GitHub to bookmark SpIob/deptend-go-test-fixture"`
     is present in the served HTML (the a11y fix).
     Attach this evidence as a code-block quote in the ADR's Verification section per
     AGENTS.md §10's evidence rule, then flip Status to Accepted.
4. **ADR 0058 status** — read the current Status line first (`docs/adr/0058`, line 3).
   It was flipped back to Proposed on 2026-09-23 pending "a green run on the pushed
   workflow." That green run now exists: **run 36000910781 (push, 2026-09-24, all 3
   jobs pass — Lint & Typecheck, Test, Integration test)**, plus the 2026-09-24
   scheduled Ingest success after the `sql.query()` fix (run 35978272261 was the last
   failure; the next scheduled run after the fix succeeded), and the `sql.query()`
   fix's local red→green reproduction is already attached in the ADR's 2026-09-24
   correction. Flip Status to Accepted with run 36000910781 as the evidence.

Also update AGENTS.md §2's ADR bullet (the "ADRs currently run through 0054" sentence is
stale — it must say 0058 and summarize the current set) IF the flips above land — the
sentence enumerates 0054/0053/0052/0047/0043 and omits 0055–0058 entirely.

## Known constraints (binding)

- **AGENTS.md is a high-conflict file (§0a)** — claim it via `.agent-locks/AGENTS.md.lock`
  before editing, release after.
- **ADR files are high-conflict (§0a)** — claim each via `.agent-locks/` before editing.
- **Don't renumber ADRs.** Check `docs/adr/` first; the current max is 0058. The flips
  above are status-line edits, not new ADRs.
- **§0.1:** verify each claim against real source/infra before editing — the evidence
  above was gathered 2026-09-25; re-verify anything that looks different by the time
  this task runs (e.g. `gh run list --workflow=perf.yml` if the perf workflow has
  changed, `gh run view 36000910781` for the CI green claim).
- **Do not** edit CHANGELOG.md unless one of the code tasks (TASK-01..04) landed in the
  same pass — changelog entries go in the same commit/PR as their motivating change,
  never backfilled (§10).
- Per AGENTS.md §0.6, load `.opencode/skills/actually-code` before writing code.

## What to do

1. Claim `AGENTS.md` via `.agent-locks/AGENTS.md.lock`.
2. Apply the four updates above (§13 items 1–2, §5 GITHUB_TOKEN row, §2 ADR bullet).
3. Claim and flip ADR 0054 and ADR 0058 to Accepted, attaching the evidence quoted
   above (and re-verified) as code-block quotes in each ADR's Verification section.
4. Release the locks.
5. `pnpm run format:check` on the touched files (AGENTS.md and ADRs are markdown —
   Prettier covers them).

## Verification gate

```bash
pnpm run format:check
```

Plus a grep-level self-check: `grep -c 'still needs .drizzle-kit migrate. for .0005'
AGENTS.md` → 0 after the fix, `grep -c 'GITHUB_TOKEN. is absent in production'
AGENTS.md` → 0, and both ADR Status lines read `Accepted`.
