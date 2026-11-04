# ADR 0063: Cargo (crates.io) as the Fourth Ecosystem

**Status:** Accepted (live-verified 2026-11-02 — see the Live verification section)
**Date:** 2026-11-02

---

## Context

Adds Rust/Cargo as DepTend's fourth ecosystem, chosen 2026-11-02 from candidates (pnpm lockfile parser, uv lock, NuGet/Maven) per the existing per-ecosystem precedent (ADR 0022 PyPI, ADR 0024 Go). Grounded against the real repo before writing: `ecosystemEnum` is `["npm", "pypi", "go"]` (schema.ts:63), ADRs run through 0062, migrations run through 0008, and all shared pipeline tables (`ecosystem` columns, board facets, mission scoring) are ecosystem-agnostic except the dispatch sites named below.

Three structural facts make Cargo the cheapest new ecosystem since Go — each verified live on 2026-11-02, not assumed:

1. **Rust versions are toolchain-enforced SemVer** (same class of fact as Go, ADR 0024 §Context): `inferSemverBump()` is reused unchanged; no PEP-440-style comparator, no new versioning dependency.
2. **`Cargo.lock` is TOML** (verified against a real lock file): `smol-toml` — already a dependency since ADR 0022 — parses it; no new lock-file dependency either.
3. **OSV's Rust records carry SEMVER-type ranges** (live probe: `GET /v1/vulns/RUSTSEC-2020-0071` → `type: "SEMVER"`, events `introduced: "0.0.0-0"` / `fixed: "0.2.0"`; ecosystem string `crates.io`): SEMVER-only range handling, identical to Go's, no ECOSYSTEM-type case.

Live API probes this grounding (2026-11-02, all from this environment):

- `POST /v1/query` + `/v1/querybatch` with `ecosystem: "crates.io"`: both accepted. Batch response shape is `{id, modified}` — identical contract to npm/pypi/go. Known-vulnerable probe: `time@0.1.43` → `GHSA-wcg3-cvx6-7396` + `RUSTSEC-2020-0071`.
- `GET https://crates.io/api/v1/crates/serde` with only a `User-Agent` header: HTTP 200; `crate.max_version` = `1.0.229`, `crate.repository` = `https://github.com/serde-rs/serde`, `description` present. No auth.
- `GET https://index.crates.io/ti/me/time` (sparse index, CDN-served): NDJSON, one JSON object per version, ascending order (last line = newest); fields `vers`, `yanked`, `pubtime`. No rate-limit policy, unlike the crates.io API.

**One known friction point, stated up front:** crates.io's API documents a ~1 request/second fair-use policy — the same fact ADR 0024 cited when it chose `proxy.golang.org` over crates.io for Go. There is no free alternative for crates.io _package metadata_ (the sparse index covers versions/yanked but not repository URLs, and it is not the same API family). This ADR adopts crates.io with a bounded-concurrency mitigation (Decision 4), not a hard pacer; the mitigation's failure mode is fail-soft by construction. Flagged as the plan's one standing decision point.

**Two pre-existing non-compile-enforced dispatch sites found during grounding** — exactly the trap class ADR 0024 Context #1 documented and closed for the four sites it found:

- `packages/core/src/scorer/mission-type-detector.ts:103-108`: `if (ecosystem === "npm" || ecosystem === "go") … else if (ecosystem === "pypi") …` — a `cargo` value falls into the pypi branch (wrong breaking-change signal patterns).
- `packages/core/src/scorer/bump-inference.ts:246-249`: same two-way shape — `cargo` would run `inferPep440Bump()` on a semver string (silently wrong bump estimates).

Both convert to exhaustive dispatch in this pass; neither can be left as a silent pypi fall-through.

## Decision 1; Ecosystem identity and detection: append cargo last

`ecosystemEnum` gains `'cargo'` (new migration; see What changed). Detection order becomes npm → PyPI → Go → cargo, preserving every existing repo's detection; only repos that resolve none of the first three manifests pay a fourth probe. `Cargo.toml` is unique to Rust, so there is no realistic tie with an earlier ecosystem (same reasoning as Go in ADR 0024).

Three call sites wire the new ingestor in, each by appending to the existing list — no router changes (ADR 0041's parallel probing treats the list generically):

- `scripts/ingest.js` (HTTP ingestor list)
- `cli/src/analyze.ts` (Local ingestor list)
- `packages/core/src/ingestor/manifest-check.ts` (submission pre-check probe list)

`IngestorResult.lock_file_format` (interface.ts) and `LockFileParseResult.format` (lock-parse.ts) gain a `"Cargo.lock"` member each — both are closed string unions, so this is a compile-visible change everywhere they flow.

**UI surface:** `app/src/lib/mission-filter-options.ts` (`ECOSYSTEM_OPTIONS`, `ECOSYSTEM_LABELS`) gains cargo; `app/tailwind.config.ts`'s `ecosystem` palette gains a color in a hue family distinct from both the existing npm/pypi/go set (purple/green/teal) and the severity palette (per that config's own comment rule) — proposed `#8E4585` (plum), exact value at implementation review. Board facets/filters are enum-driven (`ecosystemEnum.enumValues`) and need no change.

## Decision 2; Manifest scope: root `Cargo.toml` standard tables + `Cargo.lock`

Mirrors ADR 0022/0024's scoping style — cover the dominant convention, document the rest.

**Parsed** (root `Cargo.toml` only, via `smol-toml`): the `[dependencies]`, `[dev-dependencies]`, and `[build-dependencies]` tables. Mapping to the existing `dep_type` enum:

- `[dependencies]` → `production`
- `[dev-dependencies]` → `development`
- `[build-dependencies]` → `production` (required to build; documented choice)
- entries with `optional = true` → `optional` (faithful use of the existing enum value)

Three value shapes, all handled: `crate = "1.0"` (plain requirement); `crate = { version = "1.0", features = [...], optional = true }` (inline table); `crate = { workspace = true }` (workspace-inherited — resolved against the same file's `[workspace.dependencies]` when present, else `version_spec: "*"` with a warning).

**Explicitly out of scope, same shape of deferral as ADR 0022/0024:**

- Target-specific tables (`[target.'cfg(…)'.dependencies]`) — not read.
- Workspace member crates' own manifests — not fetched (a virtual workspace root with no root `[dependencies]` parses zero deps and stays `ingestionStatus: "complete"`, same precedent as npm's empty `package.json` and gorilla/mux's empty `go.mod`). Member-crate fetching is the natural follow-up if a real workspace repo's coverage proves too thin.
- `[patch]`/`[replace]`/`[exclude]` — not handled.

**`Cargo.lock`** (ADR 0038 pattern): parsed via `smol-toml`; each `[[package]]` contributes `name` → `version` to `resolvedVersions`; lock-only packages become `transitive` via the existing `mergeManifestWithLock()`. The lock format's `version` field (v3/v4) is not read — `name`/`version` are stable across formats. No yanked signal exists in Cargo.lock; none is needed for lock parsing.

## Decision 3; Effort scoring: reuse `inferSemverBump()` unchanged

Same call as ADR 0024 Decision 3, for the same reason (toolchain-enforced semver):

- `FLOOR_EXTRACTION_BY_ECOSYSTEM` (bump-inference.ts:220) gains `cargo: extractSemverFloor`.
- `inferBumpForEcosystem()`'s if/else becomes exhaustive dispatch with `cargo` joining `npm`/`go` → `inferSemverBump`.

**Known, accepted gap carried over unchanged** (§11, ADR 0022's live-verification note): `inferSemverBump()`'s upper-bound-only-range behavior (`"<5.4.0"` → floor `0.0.0` → `"major"`) now also applies to cargo dependencies declaring upper-bound-only constraints. Not fixed here; separate deliberate call.

## Decision 4; Registry metadata: crates.io API, User-Agent required, concurrency 1

New `packages/core/src/ingestor/cargo-registry.ts`, mirroring `pypi-registry.ts`'s subclass shape over `registry-base.ts`:

- `GET https://crates.io/api/v1/crates/<name>` → `crate.max_version` populates `latestVersion`; `crate.repository` populates `sourceRepo` (live-confirmed both fields on serde; fall back to `crate.repository_url` then `homepage` when `repository` is absent).
- **Required `User-Agent` header** per crates.io's documented policy (e.g. `DepTend/0.1 (+https://deptend.vercel.app)`); requests without one are subject to blocking. This is crates.io's only "auth" requirement — zero-budget compliant.
- **Rate policy mitigation:** constructed with `concurrency: 1` (a `registry-base.ts` constructor parameter that already exists), so a repo with N direct cargo deps pays ~N sequential round-trips; this plus natural fetch latency is the best-effort respect of the documented ~1 req/sec. A hard per-request pacer is a follow-up if a real repo ever trips a 429. The failure path is already fail-soft: a throttled or failed fetch warns, leaves `latest_version` null, and the writer's erosion guard preserves any previously stored value rather than writing null over it (the ADR 0061 ingestion rule).
- `isDeprecated`/`deprecationNote`: always `false`/`null` — crates.io has no package-level deprecation flag (yanked is per-release, and the API response's top-level `yanked` refers to nothing useful here); documented gap exactly like PyPI's (ADR 0022) and Go's (ADR 0024).
- `pipeline/registry-fetchers.ts`'s `REGISTRY_FETCHERS_BY_ECOSYSTEM` gains the cargo entry — compile-enforced, so `scripts/ingest.js` and `cli/src/analyze.ts` need no separate registry-selection edits beyond what the map provides.

`mission-type-detector.ts`'s if/else becomes exhaustive dispatch with `cargo` joining the `npm`/`go` branch (Cargo's semver bump → same vulnerability-fix signal patterns).

## Decision 5; OSV: `"crates.io"` identifier, SEMVER-only ranges

- `OSV_ECOSYSTEM_NAMES` (osv.ts:85) gains `cargo: "crates.io"`. **Deliberate mismatch between our internal enum value (`cargo`) and OSV's identifier string (`crates.io`)** — same namespace split as `pypi` → `"PyPI"`, made explicit and compile-enforced by the Record. Live-confirmed: both batch and detail endpoints resolve the identifier, and a version-filtered query returns only advisories affecting the queried version.
- `ACCEPTED_RANGE_TYPES` (osv.ts:97) gains `cargo: ["SEMVER"]` — live-confirmed on RUSTSEC-2020-0071 (SEMVER ranges only). The docstring's per-ecosystem range-type note extends to cargo.
- EPSS enrichment (ADR 0039) needs no code change: Rust advisories alias to GHSA/CVE IDs where present (live probe returned `GHSA-wcg3-cvx6-7396` for the same record the RUSTSEC id covers), which is what the EPSS stage keys on. Live verification confirms Rust GHSAs resolve CVEs at the usual rate.

## What changed (planned)

- `packages/core/src/db/schema.ts` + migration `0009` (`ALTER TYPE ecosystem ADD VALUE 'cargo'`) — mechanically identical to 0002 (pypi) and 0003 (go). Applied dev-first, then production, with the post-migration ledger ↔ live-catalog cross-check per AGENTS.md §12 (deptend-neon-ops procedures).
- New files, mirroring the Go Phase 7 set 1:1 (all with colocated tests):
  - `packages/core/src/ingestor/cargo-parse.ts` — pure `Cargo.toml` + `Cargo.lock` parsing
  - `packages/core/src/ingestor/cargo.ts` — `CargoIngestor` (HTTP, GitHub raw content)
  - `packages/core/src/ingestor/local-cargo.ts` — `LocalCargoIngestor` (filesystem, CLI)
  - `packages/core/src/ingestor/cargo-registry.ts` — `CratesRegistryFetcher`
- Modified:
  - `ingestor/interface.ts` — `lock_file_format` union + `"Cargo.lock"`
  - `ingestor/lock-parse.ts` — `LOCK_PARSERS` entry + `format` union + `"Cargo.lock"` (the live registry; the never-wired `utils/lock-parse.ts` second registry is untouched — its wire-or-remove decision stays Mico's, per the flagged decision point)
  - `ingestor/osv.ts` — the two Records (Decision 5)
  - `scorer/bump-inference.ts`, `scorer/mission-type-detector.ts` — exhaustive dispatch (Context, Decision 3/4)
  - `pipeline/registry-fetchers.ts` — map entry (Decision 4)
  - `ingestor/manifest-check.ts`, `scripts/ingest.js`, `cli/src/analyze.ts` — probe/ingestor lists (Decision 1)
  - `app/src/lib/mission-filter-options.ts`, `app/tailwind.config.ts` — UI surface (Decision 1)
  - `packages/core/package.json` exports map — the four new modules
- No new runtime dependencies (`smol-toml`, `semver` already present). No new devDependencies. No score-formula change; no new tables or columns beyond the enum value.

## Live verification plan (before Accepted)

1. Migration applied to dev Neon, then production, ledger cross-checked.
2. `scripts/ingest.js --repo-url` against a real, small Cargo repo (e.g. a crate with a known RUSTSEC advisory in a locked older version) → missions generated with correct severity, effort, and confidence; advisory rows carry `ecosystem: "cargo"`, `match_method: "version_resolved"` where the lock resolved.
3. Submission pre-check (`POST /api/repos`) accepts a Cargo.toml repo and rejects a manifest-less one — new probe list live.
4. OSV batch + detail responses for crates.io spot-checked against production data (the ADR 0022 pattern: confirm the range-type assumption against the live DB, not just fixtures).
5. Full §6 gate; then flip to Accepted with evidence in this file, CHANGELOG entry in the same pass, README + `docs/data-model/README.md` updated.

## As-built notes (2026-11-02, implementation pass)

The plan above shipped as written, with four deviations worth recording:

1. **The CLI's probe list lives in `cli/src/pipeline/detect-step.ts`, not `analyze.ts`** — analyze.ts delegates detection to the pipeline step, which is the file that gained `LocalCargoIngestor` as the fourth probe.
2. **Migration `0009_ambitious_wendell_vaughn` carries a second statement beyond the enum add:** drop + recreate `idx_mission_scores_composite_tier` byte-identically. `drizzle-kit generate` produced it from snapshot-definition normalization, not from live drift — the pre-migration probe showed the index present on BOTH branches, so against live Neon the DROP/CREATE pair is a reconstructive no-op (verified: identical `indexdef` before and after on dev and production). Recorded because the dev-ledger inverse-gap class (AGENTS.md §12) was the first suspect; the live catalog check is what ruled it out.
3. **A third ecosystem dispatch needed touching that the Context section didn't list:** `utils/version.ts`'s `inferBumpSize()` switch (line ~212) was already exhaustive over the three ecosystems, and `cargo`'s omission surfaced as a TS2366 "function lacks ending return" — the compile enforcement working exactly as designed. It gained `case "cargo"` alongside npm/go.
4. **The enum's width is load-bearing in test fixtures:** `db/test-utils.ts`'s `tallyRow()` builds the board tally row positionally from the enum order, and `board-queries.test.ts` asserts the tally's FILTER-column count (now 18) and per-axis equality count (now 4 for ecosystems). Both were updated in the same pass; any future ecosystem add must touch the same two fixture sites.

## Live verification (2026-11-02 — the evidence for Accepted)

1. **Migration applied to both Neon branches, ledger cross-checked.** Dev (`br-cool-grass-aocbg2b7`) first, then production (`br-square-hill-aovhsm68`), each as one transaction: the three migration statements plus the `drizzle.__drizzle_migrations` insert with the file's exact SHA-256 (`7d831351…bfe925`, `created_at` 1793592598771 ≥ the journal's last entry). Post-migration probes on both: `enum_range(ecosystem)` = `{npm, pypi, go, cargo}`, tier-index `indexdef` identical to pre-migration, ledger at 9 rows with the expected head hash. `compare_database_schema` dev↔production: empty apart from production's pre-existing `pg_stat_statements`. Dev restore point captured first: `dev-restore-point-pre-0009` (`br-spring-leaf-aomwmc2f`).
2. **Real Cargo repo, real pipeline.** `scripts/ingest.js --repo-url` could not run end-to-end from this environment (its required `GH_INGEST_TOKEN` is a GitHub-Actions secret, not present locally — see §5). The equivalent live pipeline probe ran against the same real code and the same external contracts instead: `chronotope/chrono` fetched from the real GitHub API, detected as `cargo` by the real 4-ingestor `detectEcosystem` (11 direct deps; dep_types `{production: 1, optional: 5, development: 5}` — optional-flag mapping working), chrono's absent `Cargo.lock` correctly produced the `no_lock_file` warning path. The remaining unexercised leg is the DB write path itself, which is covered by the 871-test suite plus the live migration above; a real `ingest.yml` dispatch against a Cargo repo is the natural follow-up once merged.
3. **Submission pre-check live:** `checkSubmittableRepo("chronotope", "chrono")` → `{ok: true, ecosystem: "cargo"}`; `checkSubmittableRepo("torvalds", "linux")` → `{ok: false, reason: "no_manifest"}` (the 4-probe list in action).
4. **OSV crates.io contract against real data:** `OsvFetcher.fetchAdvisories(deps, "cargo")` returned 9 real advisories for chrono's `rkyv` dependency (GHSA + RUSTSEC aliases, SEMVER-type ranges, CVSS base scores computed from vector strings — e.g. GHSA-w5cr-frph-hw7f → 7.5/high — and EPSS enrichment populated on the GHSA-aliased ones), version-filtered batch queries carrying `ecosystem: "crates.io"`.
5. **Registry live:** `CratesRegistryFetcher` against real crates.io with the required User-Agent — `serde` → 1.0.229 with sourceRepo `serde-rs/serde`, `num-traits` → 0.2.19 with `rust-num/num-traits`, zero warnings.
6. **Full §6 gate green:** typecheck (all workspaces incl. the tsconfig.eslint.json passes), Vitest (1,259 tests passing across core/scripts/cli/app: 871 + 40 + 113 + 235), clean `next build`, ESLint `--max-warnings 0`, Prettier `format:check`.

---

_The decisions above were implemented and live-verified on 2026-11-02 (same day); see the As-built notes and Live verification sections. As with ADR 0022/0024, this file was reviewed before Step 1 started._
