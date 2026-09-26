# TASK-03 — Patch the 6 production-dependency vulnerabilities

**Agent:** opencode · **Priority:** high (4 high-severity advisories in prod deps)
**Area:** root `package.json`, `packages/core/package.json`, `app/package.json`,
`pnpm-lock.yaml`, `CHANGELOG.md`

## Evidence (measured, 2026-09-25)

`pnpm audit --prod` on HEAD `07e5435` finds 6 vulnerabilities (1 low | 1 moderate |
4 high), exit 1 — which also produces the `X Process completed with exit code 1`
annotation on the CI Test job's advisory step (run 36000910781):

| Package                    | Severity | Vulnerable      | Patched  | Path                                      | GHSA                |
| -------------------------- | -------- | --------------- | -------- | ----------------------------------------- | ------------------- |
| `smol-toml`                | **high** | <=1.7.0         | >=1.7.1  | root `.` (direct dep)                     | GHSA-7w5x-hrqm-74c2 |
| `sharp`                    | **high** | <0.35.4         | >=0.35.4 | `app > next@15.5.24 > sharp@0.35.3`       | GHSA-rgj7-g3m4-5g8c |
| `browserslist`             | **high** | <=4.28.6        | >=4.28.7 | transitive (via styled-jsx > @babel/core) | GHSA-c83g-rgw3-j3cx |
| `browserslist`             | **high** | <=4.28.6        | >=4.28.7 | same                                      | GHSA-73wf-gq98-2v4g |
| `baseline-browser-mapping` | moderate | >=2.0.0 <2.11.0 | >=2.11.0 | transitive (via browserslist)             | GHSA-w5vr-8v7q-w6rv |
| `cli`                      | low      | <1.0.0          | >=1.0.0  | **none — false positive**                 | GHSA-6cpc-mj5c-m9rq |

`pnpm why cli` returns empty (no installed package, empty paths) — the `cli` advisory is
a registry name-collision with `@deptend/cli`'s unpublished name. **Do not** "fix" it;
document it as a false positive in the CHANGELOG entry.

**`smol-toml` is the load-bearing one:** it's the untrusted-manifest parser the
ingestion pipeline runs against public GitHub repos' `pyproject.toml` files — the DoS
advisory (malformed TOML) is in this project's exact threat model. Fix it first.

## Known constraints (binding)

- **Zero budget; no new dependencies** — this task only bumps existing ones in-range or
  to their patched floors.
- **ADR 0044 lockstep rule:** if the dep-add targets a package core uses, update BOTH
  the root `dependencies` block AND `packages/core/package.json`'s. `smol-toml` is a
  core import — but note TASK-04 in this same directory: `packages/core/package.json`
  currently has NO `dependencies` block (ADR 0044's Decision 1 was never implemented).
  **If TASK-04 ran before this task**, add `smol-toml`'s bump to BOTH blocks. **If this
  task runs first**, bump root's block only and leave TASK-04 to add the core block
  afterward — do not implement ADR 0044's restructure here (that's TASK-04's scope).
- The pnpm `overrides` in root `package.json` (`postcss`, `nanoid`, `sharp`) are the
  ADR 0036 security patches — but pnpm warns they're **ignored** at the new config home
  (`[WARN] The "pnpm" field in package.json is no longer read by pnpm`). **Migration
  required:** move `overrides` to `pnpm-workspace.yaml`'s `overrides:` key (pnpm ≥9.9
  reads it from there — the repo's `packageManager` is `pnpm@9.15.0`). Verify the
  override versions still land in the lockfile after the move (`grep
'(postcss@|nanoid@|sharp@)' pnpm-lock.yaml` must keep matching the same pinned
  versions: postcss@8.5.26, nanoid@3.3.18, sharp@0.35.3+). The lockfile already shows
  the override versions in effect today, so this is a config-location migration, not a
  version change.
- **`sharp@0.35.3` is pinned by the ADR 0036 override** and is vulnerable (<0.35.4). The
  override must move to `^0.35.4` (or the exact patched floor) as part of this task —
  keeping `0.35.3` pinned would leave the high advisory open. Update BOTH the
  `pnpm-workspace.yaml` override AND the lockfile resolution.
- Per AGENTS.md §0.6, load `.opencode/skills/actually-code` before writing code.

## What to do

1. **Move `pnpm.overrides` from root `package.json` to `pnpm-workspace.yaml`** (pnpm's
   new config home), bumping `sharp` to `^0.35.4` while at it. Remove the now-dead
   `pnpm` field from root `package.json` (the WARN names it explicitly).
2. **Bump `smol-toml`** `^1.7.0` → `^1.7.1` in root `package.json` (and in
   `packages/core/package.json`'s `dependencies` block if TASK-04 already created it).
3. **Bump the transitive chain**: `browserslist` (>=4.28.7) and
   `baseline-browser-mapping` (>=2.11.0) are transitive — fix via pnpm `overrides` in
   `pnpm-workspace.yaml` (the same mechanism already used for postcss/nanoid/sharp),
   NOT by adding them as direct dependencies. Add entries like
   `"browserslist": "^4.28.7"` and `"baseline-browser-mapping": "^2.11.0"` to the
   `overrides` block.
4. **`pnpm install`** to regenerate `pnpm-lock.yaml`, then verify:
   `pnpm audit --prod` exits 0 with zero advisories except the documented `cli` false
   positive (which has empty paths and is not installed — if it still appears, document
   it in the CHANGELOG entry; it is NOT fixable by a version bump).
5. **Full §6 gate.** A lockfile regeneration can break the build (drizzle-kit,
   hoisting) — run the whole thing, not just the audit.

## Do NOT

- Do not close/merge dependabot PRs (#13/#14/#16 are open) — those are Mico's
  deploy-window decisions and are auto-deploy on merge.
- Do not "fix" the `cli` false-positive advisory by any version bump.
- Do not add a `pnpm.audit` config or silence the CI advisory step — the audit gate's
  noise is real signal once the false positive is documented.
- Do not touch `docs/adr/` (no new ADR needed: this is in-range patching + a config
  location migration for an already-documented override set; if you disagree and want
  an ADR for the overrides migration, add **ADR 0059** — check `docs/adr/` first, the
  current max is 0058).

## Verification gate (run in this order before claiming done)

```bash
pnpm run typecheck && pnpm -r test && pnpm run build && pnpm run lint && pnpm run format:check
```

Plus `pnpm audit --prod` exit 0 (or only the documented false positive), and the
lockfile's override versions verified by grep.
