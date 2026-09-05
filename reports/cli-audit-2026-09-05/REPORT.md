# DepTend CLI audit: 2026-09-05

Real-network end-to-end testing of `@deptend/cli` against four public repos covering all three supported ecosystems (npm, PyPI, Go). Captures observed behavior, surfaces bugs the existing mocked test suite misses, and proposes a ranked improvement list. **Proposals only; no code changes in this pass.**

Built and run with the project's pinned toolchain:

- Node 26.0.0 (Homebrew; matches `.nvmrc` `v26.0.0` per AGENTS.md §4)
- `@deptend/core` freshly built via root `postinstall`
- `@deptend/cli` built via `pnpm --filter @deptend/cli build`
- `GITHUB_TOKEN` loaded from `.env.local` for all rows except the explicit unauthenticated row

Tested invocations live at `/tmp/*.json` for the matrix rows that wrote a file. Wall-clock timings come from `time(1)` on a single dev machine, not from a stable benchmark; treat as rough, not authoritative.

---

## 1. TL;DR

**What works** (live-verified): the happy path on DepTend, on `lodash/lodash`, on a temp PyPI repo, and on `SpIob/deptend-go-test-fixture`. All three ecosystems (npm, PyPI, Go) detect correctly; OSV advisories resolve; npm registry / PyPI JSON / Go proxy metadata all surface; mission ranking is deterministic across runs; `confidence_notes` are populated; the human summary formats without crashing; the JSON shape matches the documented `AnalyzeResult` contract.

**What is broken or rough** (live-verified):

- **B1: `--output` with no value silently no-ops.** Exit 0, no file written, no warning, the human summary is printed instead. Documented candidate §8.8 confirmed-real. (CLI `index.ts:76-77` + `output.ts:21`.)
- **B2: A non-existent local repo path returns exit 0 with three warnings and an empty mission list**, indistinguishable from a real-but-clean repo. The user has no signal that the path was wrong. (CLI `analyze.ts` returns the last probe's payload per `detectEcosystem`'s all-fail path; the warnings are emitted but the exit code never reflects the user-facing error.)
- **B3: Duplicate `--output` flags are last-write-wins with no warning.** `--output a.json --output b.json` writes only `b.json` silently. (CLI `index.ts:71-85` `parseArgs` has no dedup.)
- **B4: `advisory.url` is hard-coded to `osv.dev` even when `source: "ghsa"`.** For GitHub-sourced advisories the canonical URL is `github.com/advisories/{id}`. (CLI `analyze.ts:199`.)
- **B5: `confidence_notes` says "No lock file was parsed" even when `lock_file_present: true`.** The note is set unconditionally per mission, not gated on the per-repo lock-file flag. Surfaced in the live DepTend run. (Scoring layer; not in the CLI itself but the CLI surfaces it.)
- **B6: `composite_score` is on a roughly 0-10 scale, but real critical/CRITICAL missions on `lodash/lodash` cap at 9.0/10.** Not a bug. The score formula is documented. But the `/10` suffix in the human summary (`output.ts:56`) implies a 0-10 scale that the scoring actually doesn't fill. Cosmetic.
- **B7: 82 missions from a 4-dependency PyPI repo, 360 lines of output.** No progress indication, no pagination, no filtering. The user has no way to narrow without dropping into the JSON. Major UX cliff.
- **B8: Identical titles for the same package across multiple advisories.** `"Update semver to fix a high vulnerability"` appears 2× (different fixed versions) and `"Update smol-toml to fix a medium vulnerability"` 2×, and `"Update golang.org/x/crypto to fix a critical vulnerability"` 8×. The dashboard fixed this in 2026-08-30 (CHANGELOG / ADR 0051 — append short OSV prefix to title). The CLI does not have that fix. (CLI `analyze.ts:170` uses `copy.title` from `mission-copy.ts:60-67` which generates the title from package + severity + fixedVersion, never the OSV id.)
- **B9: `effort_label: "trivial"` is rendered identically to `"low"` in the human summary.** No visual distinction. Surfaces on `lodash/lodash`. (CLI `output.ts:57` prints `effort: ${mission.effort_label}`. `low` and `trivial` look the same width.)
- **B10: `Upgrade X to 7.5.2 or later` when the declared range is `^7.8.5`.** The fixed version (7.5.2) is a _downgrade_ of the declared range, and "or later" is a meaningless suffix. The CLI phrasing mirrors what the dashboard does, but it's a UX bug. The action_hint reads as a recommendation to downgrade. Mission-copy layer; CLI surfaces it.
- **B11: `parseArgs` and `output.ts` have no unit tests.** The mocked suite covers `analyze` and `build-rows` only. (CLI `cli/src/output.ts:1-73` and `cli/src/index.ts:61-95`.)

**What is not a bug** (live-verified, contradicts a Phase 0 hypothesis):

- `--github-url` with trailing path (`/issues`, `/extra/path`) is correctly rejected by `parseGithubUrl` (`packages/core/src/db/repos.ts:21-22` regex). Candidate §8.11 dropped.
- `--json` is correctly ignored when `--output` is set (`output.ts:21-25` takes precedence). PASS.
- Two consecutive CLI runs produce byte-identical JSON (modulo `generated_at`). ADR 0018 ranking-determinism fix holds on real data. PASS.
- Per-dependency OSV `GET /v1/vulns/{id}` runs at the documented concurrency of 10 (`packages/core/src/ingestor/osv.ts:70`) and finishes in ~7s for 82 missions. No bottleneck on small repos. The performance candidate §8.16 is _not_ triggered.
- `npm-side inferSemverBump() reports "major" for upper-bound-only ranges` — known settled gap (AGENTS.md §11); confirmed on real data, left alone per the project rule.
- `--help` and `-h` both print the USAGE banner, exit 0. PASS.

---

## 2. Test matrix — actual results

18 rows. Each row: invocation (one line) → captured result → verdict.

### Negative paths

| #    | Invocation                                                                                                      | Result                                                                                                                                        | Verdict                         |
| ---- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 2.2  | `cli/dist/index.js . --github-url not-a-url`                                                                    | Exit 1; "Error: --github-url \"not-a-url\" doesn't look like a valid GitHub repo URL. Expected something like https://github.com/owner/name." | **PASS**                        |
| 2.3  | `cli/dist/index.js .` (no `--github-url`)                                                                       | Exit 1; "Error: Missing required --github-url flag." + USAGE banner                                                                           | **PASS**                        |
| 2.15 | `cli/dist/index.js . --bogus-flag`                                                                              | Exit 1; "Error: Unrecognized argument: --bogus-flag" + USAGE banner                                                                           | **PASS**                        |
| 2.x1 | `cli/dist/index.js . --github-url https://github.com/spiob-this-user-doesnt-exist-12345/this-repo-doesnt-exist` | Exit 1; "Error: GitHub repo not found: ... It may be private, deleted, or the URL may be incorrect."                                          | **PASS**                        |
| 2.x2 | `cli/dist/index.js . --github-url https://github.com/SpIob/DepTend/issues`                                      | Exit 1; rejected by `parseGithubUrl` regex before the network call                                                                            | **PASS**                        |
| 2.16 | `cli/dist/index.js . --github-url https://github.com/SpIob/DepTend --output` (trailing flag, no value)          | Exit 0; human summary printed, **no file written, no warning**                                                                                | **FAIL — B1**                   |
| 2.x3 | `cli/dist/index.js . --github-url https://github.com/SpIob/DepTend --output /tmp/a.json --output /tmp/b.json`   | Exit 0; only `/tmp/b.json` written                                                                                                            | **FAIL — B3** (last-write-wins) |
| 2.1  | `cli/dist/index.js /tmp/no-such-dir --github-url https://github.com/SpIob/DepTend`                              | Exit 0; "0 go dependencies scanned"; 3 warnings; 0 missions                                                                                   | **FAIL — B2** (silent success)  |

### Help / version

| #    | Invocation                 | Result               | Verdict  |
| ---- | -------------------------- | -------------------- | -------- |
| 2.4a | `cli/dist/index.js --help` | Exit 0; USAGE banner | **PASS** |
| 2.4b | `cli/dist/index.js -h`     | Exit 0; USAGE banner | **PASS** |

### Live-network happy path — npm

| #     | Invocation                                                                                                         | Result                                                                                                                    | Verdict                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 2.5   | `cli/dist/index.js . --github-url https://github.com/SpIob/DepTend --output /tmp/deptend-self.json`                | Exit 0; "✓ Wrote 5 mission(s) to /tmp/deptend-self.json"; 7.3s wall; 21 npm deps; 5 missions                              | **PASS**                                   |
| 2.6   | `cli/dist/index.js . --github-url https://github.com/SpIob/DepTend --json`                                         | Exit 0; full JSON on stdout                                                                                               | **PASS**                                   |
| 2.x4  | `cli/dist/index.js . --github-url https://github.com/SpIob/DepTend` (no flags)                                     | Exit 0; human summary to stdout                                                                                           | **PASS** with B1, B4, B5, B8, B10 surfaced |
| 2.7   | `cli/dist/index.js . --github-url https://github.com/SpIob/DepTend --output /tmp/x.json --json`                    | Exit 0; `/tmp/x.json` written; stdout is the file confirmation only                                                       | **PASS** per documented contract           |
| 2.8   | `cli/dist/index.js . --github-url https://github.com/SpIob/DepTend --output /dev/null`                             | Exit 0; "Wrote 5 mission(s) to /dev/null"                                                                                 | **PASS** (cosmetic only)                   |
| 2.18a | `cli/dist/index.js /tmp/lodash --github-url https://github.com/lodash/lodash` (1-dep fixture for `lodash@^4.17.0`) | Exit 0; 4.8s; 10 missions; score range 6.7 – 9.0; effort labels `trivial`, `low`; severities `critical`, `high`, `medium` | **PASS** with B6, B9 surfaced              |
| 2.14  | `cli/dist/index.js . --github-url https://github.com/SpIob/DepTend` with `env -u GITHUB_TOKEN`                     | Exit 0; **no startup warning** about unauthenticated mode; same 5 missions                                                | **FAIL — B11 (gap, not a crash)**          |

### Live-network happy path — PyPI

| #    | Invocation                                                                                            | Result                                                                                                          | Verdict                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 2.10 | `cli/dist/index.js /tmp/pypi-repo --github-url https://github.com/SpIob/DepTend` (4-dep PyPI fixture) | Exit 0; ~10s; **82 missions**; ecosystem: `pypi`; 26 warnings (mostly "No CVSS score" for old PYSEC advisories) | **PASS** with B7 (UX cliff) and B10 (jinja2 downgrade action hint) surfaced |

### Live-network happy path — Go

| #    | Invocation                                                                                                     | Result                                                                                                       | Verdict                                |
| ---- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| 2.11 | `cli/dist/index.js /tmp/go-repo --github-url https://github.com/SpIob/DepTend` (4-dep Go fixture)              | Exit 0; ~6.4s; 66 missions; ecosystem: `go`; `golang.org/x/crypto` produces 8 missions with identical titles | **PASS** with B8 (clone of 0051 issue) |
| 2.12 | `cli/dist/index.js /tmp/deptend-go-test-fixture --github-url https://github.com/SpIob/deptend-go-test-fixture` | Exit 0; 58 missions; 2 deps; real `GO-2025-*` advisories                                                     | **PASS**                               |

### Determinism

| #    | Invocation                                                             | Result    | Verdict                                           |
| ---- | ---------------------------------------------------------------------- | --------- | ------------------------------------------------- |
| 2.13 | Run 2.5 twice with `sleep 2` between; diff JSON (minus `generated_at`) | Zero diff | **PASS** — full ADR 0018 determinism on real data |

### Coverage

| #   | Invocation                        | Result            | Verdict                                                          |
| --- | --------------------------------- | ----------------- | ---------------------------------------------------------------- |
| 4.1 | `pnpm --filter @deptend/cli test` | 18/18 pass; 2.24s | **PASS** with **B11** flagged (output.ts and parseArgs untested) |

---

## 3. Observed issues — categorized

### Correctness

- **B1 / B3** — input-handling bugs at `cli/src/index.ts:71-95`. Silent no-op or silent overwrite; both user-hostile.
- **B4** — `advisory.url` is hard-coded at `cli/src/analyze.ts:199` and ignores `advisory.source`.
- **B5** — `confidence_notes` includes "No lock file was parsed for this dependency" even when the top-level `lock_file_present: true`. Lives in the scoring layer (`packages/core/src/scorer/mission-scorer.ts`); the CLI inherits and surfaces it. Two ways to fix: gate the note on a per-dependency signal, or surface `lock_file_present` more prominently in the CLI summary.

### UX (real-network evidence)

- **B7** — pagination/filtering/progress. Without any of these, 4 deps → 360 lines of stdout and a 7-second silence. The user has no signal that work is in progress, and the only way to see "just the critical ones" is to dump JSON and pipe through `jq`.
- **B8** — same-package / same-severity duplicate titles. The dashboard's 2026-08-30 fix (CHANGELOG / ADR 0051) is **not** mirrored in the CLI's mission-copy generation path.
- **B9** — `effort_label: trivial` and `effort_label: low` render as the same width. The user can't tell apart a "patch-only" trivial from a "minor" low-effort mission at a glance.
- **B10** — `action_hint` says "Upgrade X to <fixed_version> or later" with no awareness of the declared range. When the fixed version is a downgrade (real example: `semver ^7.8.5` with `fixed_version: 7.5.2`), the recommendation reads as a downgrade. The mission-copy layer doesn't have a "downgrade" or "pin to" template.

### Output formatting

- **B6** — `/10` is implied but `composite_score` rarely reaches 10. Either the suffix should be `/9` (true observed ceiling for this dataset) or removed.
- The human summary's "[SEVERITY] 5.0/10" prefix is uppercase, severity enum is lowercase. Cosmetic. Candidate only; not a bug.

### Performance

- 4-dep PyPI repo → 82 missions, ~10s. Per-dependency OSV `GET /v1/vulns/{id}` runs at concurrency 10 (`packages/core/src/ingestor/osv.ts:70`). No observable bottleneck on small repos. The `lodash` run finishes in 4.8s. **Performance candidate §8.16 is not triggered by the live data.** Dropped.

### Accessibility / terminal-friendliness

- No TTY detection; no color; no `NO_COLOR` support; no progress dots; no `wrap-ansi`. All candidates §8.1 / §8.5 / §8.7 / §8.17 / §8.18 still stand.

### Error surfacing

- **B2** — non-existent local path returns exit 0. The warnings tell the truth, but exit code doesn't.
- `--github-url` errors are clean (exit 1, message + USAGE).
- Network errors (e.g. nonexistent GitHub repo) are clean.

---

## 4. Improvement list — ranked

Each item: title · category · size · files · ponytail rung · lazy alternative (or none) · ADR threshold (per AGENTS.md §10).

### Tier 1 — bugs to fix first

#### I-1. Fix `--output` no-value silent no-op

- **Category:** correctness
- **Size:** S (<1h, 3-5 lines)
- **Files:** `cli/src/index.ts:76-77` and `cli/src/output.ts:21`
- **Ponytail rung:** 7 — guard against the missing-value case at parse time. `argv[++i]` returns `undefined`; current code does `?? null` and the output writer checks `!== null`. The fix: if the next arg is `undefined` or starts with `-`, throw.
- **Lazy alternative:** none — rung 6 is the floor here, and the current code is _on_ rung 6 but mis-spec'd (treats `null` and `undefined` as "user didn't ask for output"). Just tighten the check.
- **ADR threshold:** No. Single-flag UX fix.

```ts
// Current: cli/src/index.ts:76-77
} else if (arg === "--output") {
  outputPath = argv[++i] ?? null;

// Fix: throw on missing value
} else if (arg === "--output") {
  const next = argv[++i];
  if (next === undefined || next.startsWith("-")) {
    throw new Error(`--output requires a file path argument.`);
  }
  outputPath = next;
```

#### I-2. Fix duplicate `--output` silent overwrite

- **Category:** correctness
- **Size:** S
- **Files:** `cli/src/index.ts:71-95`
- **Ponytail rung:** 7 — track flags in a `Set`, throw on second occurrence. One variable, one check.
- **Lazy alternative:** none.
- **ADR threshold:** No.

#### I-3. Fix `advisory.url` for GHSA-source advisories

- **Category:** correctness
- **Size:** S
- **Files:** `cli/src/analyze.ts:199`
- **Ponytail rung:** 6 — one-line switch expression on `advisory.source`. `advisory.source === "ghsa" ? github.com/advisories/{id} : osv.dev/vulnerability/{id}`. Or a `Record<AdvisorySource, (id: string) => string>` map if more sources land.
- **Lazy alternative:** none — the URL is wrong right now.
- **ADR threshold:** No. The dashboard does the same thing; this would be a mirror of whatever the dashboard does, no new contract.

#### I-4. Surface lock-file presence in the confidence note (or gate it)

- **Category:** correctness
- **Size:** M (touches scoring layer, not just CLI)
- **Files:** `packages/core/src/scorer/mission-scorer.ts` (gate the note), `cli/src/output.ts` (optional CLI-side display)
- **Ponytail rung:** 2 — reuse: the lock-file signal already exists at the top level of the analyze result. The fix is in the scoring layer, not the CLI; the CLI just stops being the place this bug surfaces.
- **Lazy alternative:** if the scoring layer can't be touched in this pass, mirror the gating in `analyze.ts:178` (CLI-only): filter `confidence_notes` to drop the lock-file one if `ingestorResult.lock_file_present` is true. Rung 6 from the CLI side; rung 2 from the project side.
- **ADR threshold:** No.

#### I-5. Mirror dashboard's title disambiguation (CHANGELOG / ADR 0051) in the CLI

- **Category:** UX
- **Size:** S
- **Files:** `cli/src/analyze.ts:170` (use `copy.title` as-is, but `mission-copy.ts` would also need the change to actually produce the disambiguated title)
- **Ponytail rung:** 2 — reuse: the dashboard's fix already exists. The CLI uses the same `mission-copy.ts:buildVulnerabilityFixTitle` (`packages/core/src/scorer/mission-copy.ts:60-67`); the right fix is to teach that function to append the OSV short prefix when two advisories would otherwise produce identical titles. **Read the dashboard's fix first** (search `app/src/components/mission-card.tsx:276-281` per the CHANGELOG); port the _generator-side_ fix into `mission-copy.ts` so both surfaces get it for free.
- **Lazy alternative:** none — this is a parity fix, not a new feature.
- **ADR threshold:** No.

### Tier 2 — UX cliffs the live run revealed

#### I-6. Add filtering flags to the CLI

- **Category:** UX
- **Size:** M
- **Flags:** `--severity <critical|high|medium|low|unknown>`, `--ecosystem <npm|pypi|go>`, `--limit N`
- **Files:** `cli/src/index.ts:61-95` (parseArgs), `cli/src/output.ts:35-72` (human summary filter) — apply to the _array_, not at the OSV layer
- **Ponytail rung:** 6 — add a `filters: ParsedFilters` field to `ParsedArgs`, pass it through to `writeOutput`, filter `result.missions` before formatting. Filter is a 4-line pure function on `(mission, filter) => boolean`.
- **Lazy alternative:** none. Stdlib covers parsing the values.
- **ADR threshold:** Borderline. `--severity` is a _new public CLI flag_; not architecturally major but a new user-facing contract. Flag for ADR if pursued; I'd say no, the dashboard already has the same filter (`mission-filter-bar.ts`).

#### I-7. Add progress indication to the CLI

- **Category:** UX
- **Size:** S
- **Files:** `cli/src/analyze.ts` (around lines 95-150)
- **Ponytail rung:** 4 — native platform feature. `process.stderr.isTTY` to gate; `process.stderr.write(".")` per stage. Three stages: "Detecting ecosystem", "Fetching OSV advisories", "Fetching registry metadata", "Scoring". One `if (process.stderr.isTTY)` block; `--no-progress` to opt out.
- **Lazy alternative:** none. Stdlib TTY detection covers it.
- **ADR threshold:** No.

#### I-8. Add `--quiet` / `--summary` one-liner mode

- **Category:** UX (CI / pre-commit use case)
- **Size:** S
- **Files:** `cli/src/index.ts:61-95`, `cli/src/output.ts:18-33`
- **Ponytail rung:** 6 — `OutputOptions` gets a `summary: boolean`; if true, print one line: `5 missions: 3 critical, 1 high, 1 medium (5 low-confidence)`. Exit code 1 if any critical-severity mission.
- **Lazy alternative:** none.
- **ADR threshold:** No.

### Tier 3 — output formatting

#### I-9. `NO_COLOR` + TTY-gated severity colors

- **Category:** accessibility / UX
- **Size:** S
- **Files:** `cli/src/output.ts:51-62`
- **Ponytail rung:** 4 — `process.stderr.isTTY && !process.env.NO_COLOR` gate; ANSI `\x1b[31m` (critical), `\x1b[33m` (high), etc. No dep. Maps are 4 lines.
- **Lazy alternative:** none.
- **ADR threshold:** No.

#### I-10. Distinguish `effort_label: "trivial"` visually from `low`

- **Category:** UX
- **Size:** S
- **Files:** `cli/src/output.ts:57`
- **Ponytail rung:** 6 — color or symbol. With rung 4 colors: `trivial` is dim green, `low` is green, `medium` is yellow, `high` is red. Or prepend a single character (`·` for trivial, `+` for low, etc.). Stdlib.
- **Lazy alternative:** Just print `effort: trivial` (the label) — the human summary already does that, but `trivial` and `low` are the same width so they look identical at a glance. The fix is visual not textual.
- **ADR threshold:** No.

#### I-11. Add `--verbose` / `-v` to print scoring inputs in the human summary

- **Category:** UX
- **Size:** S
- **Files:** `cli/src/output.ts:51-62`
- **Ponytail rung:** 6 — add a `verbose: boolean` to `OutputOptions`; when true, expand each mission's `composite_score` to include `impact_score`, `ecosystem_value_score`, `cvss_score`, `fixed_version`, `confidence_notes`. Reuses everything already in the JSON.
- **Lazy alternative:** none.
- **ADR threshold:** No.

#### I-12. Fix `action_hint` downgrade phrasing

- **Category:** UX / correctness
- **Size:** M (touches `mission-copy.ts`, scoring context)
- **Files:** `packages/core/src/scorer/mission-copy.ts` (the `action_hint` builder)
- **Ponytail rung:** 2 — reuse: the dashboard has the same problem, presumably. Verify against `app/src/components/mission-card.tsx` (CHANGELOG 0051 mentions `Fix: 0.52.0` for the golang.org/x/crypto case). If the dashboard already has a "downgrade" template, port it. If not, the right fix is to compare `fixedVersion` to the _declared range_ and switch the verb (`Upgrade`/`Downgrade`/`Pin to`).
- **Lazy alternative:** none.
- **ADR threshold:** No.

#### I-13. Remove the misleading `/10` suffix or replace with the actual ceiling

- **Category:** cosmetic
- **Size:** S
- **Files:** `cli/src/output.ts:56`
- **Ponytail rung:** 6 — either drop the suffix (just print `5.0`) or compute the real ceiling per dataset. Drop is the rung-6 answer.
- **Lazy alternative:** none.
- **ADR threshold:** No.

### Tier 4 — test coverage

#### I-14. Add `output.ts` unit tests

- **Category:** testing
- **Size:** S (4 tests)
- **Files:** new `cli/src/output.test.ts`
- **Ponytail rung:** 7 — pin the four branches:
  1. `outputPath !== null` → file written + "✓ Wrote N to path" stdout
  2. `outputPath === null && json` → stdout gets the JSON
  3. `outputPath === null && !json && missions.length === 0` → human summary with "No open vulnerability missions found."
  4. `warnings.length > 0` → warnings rendered at the bottom
- **Lazy alternative:** none.
- **ADR threshold:** No.

#### I-15. Add `parseArgs` unit tests in `index.ts`

- **Category:** testing
- **Size:** S (6-7 tests)
- **Files:** new `cli/src/index.test.ts` (or a sibling `parse-args.test.ts` if `index.ts` is awkward to import due to its top-level `main().catch(...)`)
- **Ponytail rung:** 7 — pin:
  1. `--help` / `-h` → returns `null`
  2. Missing `<repo-path>` → throws
  3. Missing `--github-url` → throws
  4. Bad `--github-url` → caught at `parseGithubUrl`, throws
  5. `--output` with no value → throws (once I-1 lands)
  6. Duplicate `--output` → throws (once I-2 lands)
  7. Unknown flag → throws
- **Lazy alternative:** none.
- **ADR threshold:** No.

### Tier 5 — observability / docs

#### I-16. Mirror `scripts/ingest.js`'s `GITHUB_TOKEN`-unset startup warning

- **Category:** observability
- **Size:** S
- **Files:** `cli/src/index.ts:113` (just after the token read)
- **Ponytail rung:** 2 — reuse: `scripts/ingest.js:119-120` already has the exact pattern. Import as a string constant from `@deptend/core` if it's worth a refactor; otherwise copy the same two lines.
- **Lazy alternative:** none. This is a "the existing pattern exists; mirror it" fix.
- **ADR threshold:** No.

#### I-17. Reject non-existent local path with a clearer exit code

- **Category:** UX (B2)
- **Size:** S
- **Files:** `cli/src/index.ts:97-123` (after `parsedUrl` check) OR `cli/src/analyze.ts:88-100` (after the local-`detectEcosystem` call, if `dependencies_scanned === 0` AND no warnings include a manifest-found message, exit 1)
- **Ponytail rung:** 7 — a single early check. **Note:** the current behavior (exit 0 with warnings) is _also_ what a real-but-clean repo produces. Distinguishing "no manifest found" from "manifest found, all deps clean" is the actual fix. The cleanest place is: if `result.dependencies_scanned === 0` AND `result.warnings.some(w => /No package\.json|No usable pyproject|No go\.mod/.test(w))` then exit 1 with a "no manifest found at <path>" message.
- **Lazy alternative:** rung 6 — `if (dependencies_scanned === 0) throw` would also work, but conflates "no manifest" with "clean repo". The condition above distinguishes them.
- **ADR threshold:** No. Behavior change; not a contract change.

### Dropped during ponytail filtering

- **Candidate §8.6 (categorize warnings)** — dropped. The `26 warning(s)` wall is a real UX issue (B7), but the fix is in the human summary's _structure_ (filtering, progress, I-6 / I-7), not in classifying each warning. Once I-6 lands, the user filters; once I-7 lands, the user sees progress. Warning classification is a separate problem; punt.
- **Candidate §8.10 (`ingestionStatus: "complete"` is misleading for CLI rows)** — dropped. The `Repo` row is fabricated in-memory and never persisted; the value is local to a single process. Misleading to a code reader but functionally inert. Rung 1.
- **Candidate §8.16 (parallelize OSV per-ID GETs)** — dropped. Live data shows 4-dep PyPI finishes in 10s at the documented concurrency of 10. Not a bottleneck on this dataset. Re-evaluate if a real 200-dep repo shows different numbers.
- **Candidate §8.11 (reject trailing path in `--github-url`)** — dropped. Already rejected by the regex.
- **Candidate §8.18 (title wrapping)** — dropped for now. Real titles on the captured data max out at ~80 chars; wrapping only matters at much longer titles, which `mission-copy.ts:60-67` doesn't currently produce. Verify after a re-read of the title builder.
- **Candidate §8.13 (mixed snake_case / camelCase)** — dropped. The dashboard uses the same shape (ADR 0011 row-type authority). Flag for Mico's call only; do not change.

---

## 5. Decisions surfaced (per AGENTS.md §0.3, decision points flagged not resolved)

1. **I-5 title disambiguation:** the fix is in `mission-copy.ts`, which is shared with the dashboard. The dashboard already has this fix (CHANGELOG / ADR 0051) at the _display_ layer (mission-card.tsx:276-281), not the _generator_ layer. Port the generator-side fix to mission-copy.ts so the CLI gets it for free, or mirror the display-layer fix in `cli/src/output.ts` (CLI-only). The former is the rung-2 answer; the latter is rung 6. **Mico's call.**
2. **I-12 downgrade phrasing:** same shape as I-5. The dashboard has the same problem. **Verify the dashboard's behavior on a real downgrade case before deciding the fix's scope.**
3. **I-17 exit-code behavior change:** currently exit 0 on a non-existent path. Changing to exit 1 is a user-visible behavior change; the warnings-on-stdout is the current contract. If anyone is parsing the CLI's stdout in a script that depends on exit 0 for "analysis completed, even with no missions," this is a breaking change. **Flag, don't silently change.**

---

## 6. Coverage gap analysis

Mocked test suite (`pnpm --filter @deptend/cli test`): **18 tests, all passing, 2.24s.**

| Module                                         | Test count                                         | Branches covered                                                                                                                                                      | Live-run-only behavior caught                                                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analyze.ts`                                   | 7                                                  | npm happy, npm clean, npm no-manifest, pypi happy, go happy, ranking tie-break (ADR 0018), changelog-signals end-to-end (ADR 0029)                                    | B5 (lock-file note in confidence_notes), B8 (title disambiguation)                                                                                             |
| `build-rows.ts`                                | 11                                                 | `buildRepo` happy + missing-topics, `buildDependencies` registry merge + empty + pypi + go (ADR 0022/0024), `buildAdvisories` happy, `buildCandidatePairs` 4 branches | (none — this layer is pure)                                                                                                                                    |
| `output.ts`                                    | **0**                                              | nothing                                                                                                                                                               | B1 (`--output` no-value), B2 (no-manifest success), B6 (`/10` ceiling), B7 (no progress), B8 (duplicate titles), B9 (trivial/low visual), B10 (downgrade hint) |
| `index.ts` (`parseArgs` + `main`)              | **0**                                              | nothing                                                                                                                                                               | B3 (duplicate `--output`), the negative-path matrix rows in §2                                                                                                 |
| `analyze.ts:155-208` (the score-and-copy loop) | partial — covered via `analyze.test.ts` end-to-end | the shape of the `AnalyzedMission` object is covered, but the per-mission field set isn't pinned at the boundary                                                      | (the `confidence_notes` per-mission assertion is a candidate for I-15's tests)                                                                                 |

**Bottom line:** the mocked suite covers the _plumbing_. The bugs surfaced in this audit (B1, B3, B4, B5, B8, B9, B10) all live in code paths the mocked suite never reaches. The path forward is I-14 + I-15 to pin those branches; live-network tests like this audit become a once-per-quarter regression check, not the primary coverage.

---

## 7. Appendix

### A. USAGE banner (captured live)

```
Usage: deptend <repo-path> --github-url <url> [--output <file>] [--json]

Arguments:
  <repo-path>      Local path to the repo root (containing package.json)

Options:
  --github-url     GitHub URL of the repo, e.g. https://github.com/owner/name (required)
  --output <file>  Write the full JSON result to this file
  --json           Print the full JSON result to stdout
  --help, -h       Show this message

Environment variables:
  GITHUB_TOKEN     Optional. Raises the GitHub API rate limit to 5,000 req/hr.
```

### B. Sample mission JSON (DepTend's first mission, captured live)

```json
{
  "title": "Update semver to fix a high vulnerability",
  "description": "semver vulnerable to Regular Expression Denial of Service\n\nsemver is declared as \"^7.8.5\" and used as a production npm dependency of this repo. Severity: high (CVSS 7.5).\nReported via GHSA-c2qf-rxjj-qqgw (GHSA).",
  "action_hint": "Upgrade semver to 7.5.2 or later — low effort (minor version bump).",
  "composite_score": 5.013951330731722,
  "impact_score": 7.5,
  "ecosystem_value_score": 1.284878326829305,
  "effort_label": "low",
  "confidence": "low",
  "confidence_notes": [
    "No lock file was parsed for this dependency, so the currently-installed version is estimated from its declared range rather than confirmed.",
    "The number of packages depending on this repo's published package couldn't be checked, so ecosystem value is based on stars and issue activity only."
  ],
  "scoring_version": "1.1.0",
  "scoring_inputs": {
    "impact": {
      "cvss_score": 7.5,
      "severity": "high",
      "is_transitive": false,
      "dep_type": "production",
      "days_since_advisory": 1171,
      "epss_score": null
    },
    "effort": {
      "semver_bump": "minor",
      "has_migration_guide": false,
      "breaking_change_signals": []
    },
    "ecosystem_value": { "repo_stars": 1, "open_issues_count": 9, "downstream_dependents": null }
  },
  "dependency": {
    "package_name": "semver",
    "version_spec": "^7.8.5",
    "dep_type": "production",
    "latest_version": "7.8.5",
    "is_deprecated": false
  },
  "advisory": {
    "osv_id": "GHSA-c2qf-rxjj-qqgw",
    "source": "ghsa",
    "severity": "high",
    "cvss_score": 7.5,
    "fixed_version": "7.5.2",
    "summary": "semver vulnerable to Regular Expression Denial of Service",
    "url": "https://osv.dev/vulnerability/GHSA-c2qf-rxjj-qqgw"
  }
}
```

Note B4 in action: `source: "ghsa"` paired with `url: https://osv.dev/vulnerability/GHSA-c2qf-rxjj-qqgw` — the URL is wrong. I-3.

### C. Wall-clock timings (single dev machine, indicative only)

| Invocation                                                                                     | Wall clock | Notes               |
| ---------------------------------------------------------------------------------------------- | ---------- | ------------------- |
| `cli/dist/index.js . --github-url .../DepTend` (npm)                                           | 7.3s       | 21 deps, 5 missions |
| `cli/dist/index.js /tmp/lodash --github-url .../lodash` (npm)                                  | 4.8s       | 1 dep, 10 missions  |
| `cli/dist/index.js /tmp/pypi-repo --github-url .../DepTend` (PyPI)                             | 10.0s      | 4 deps, 82 missions |
| `cli/dist/index.js /tmp/go-repo --github-url .../DepTend` (Go)                                 | 6.4s       | 4 deps, 66 missions |
| `cli/dist/index.js /tmp/deptend-go-test-fixture --github-url .../deptend-go-test-fixture` (Go) | ~6s        | 2 deps, 58 missions |

OSV per-ID GET concurrency of 10 is sufficient for these sizes; not flagged.

### D. Toolchain

- `node`: v26.0.0 (Homebrew; pinned by `.nvmrc` per AGENTS.md §4)
- `pnpm`: 9.15.0 (project-pinned)
- `@deptend/core`: built from HEAD via `pnpm install` postinstall
- `@deptend/cli`: built from HEAD via `pnpm --filter @deptend/cli build`
- `GITHUB_TOKEN`: present in `.env.local`, used for all rows except 2.14
- No changes to source, no commits, no `npx` publish step (CLI is "not yet published to npm" per AGENTS.md §2)
