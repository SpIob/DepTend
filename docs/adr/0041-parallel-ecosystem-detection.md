# ADR 0041; Parallel ecosystem detection

**Status:** Proposed
**Date:** 2026-08-29

---

## Context

`detectEcosystem()` (`packages/core/src/ingestor/detect.ts`) probes `[NpmIngestor, PyPIIngestor, GoIngestor]` strictly in series. The contract is "first match wins" (ADR 0022, extended in ADR 0024 for Go): iterate the array, return the first ingestor whose `parseDependencies()` reports `manifest_resolved: true`. If none resolve, combine every attempt's warnings and return the last attempt's payload with `manifest_resolved: false`.

The cost of this serialization, against three real probes today:

- **NpmIngestor.parseDependencies** (`packages/core/src/ingestor/npm.ts`): one HEAD-or-GET for `package.json`, then a sequential probe of `LOCK_FILE_NAMES` (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`); a 2–3 round-trip tail depending on which lock file (if any) the repo has.
- **PyPIIngestor.parseDependencies** (`packages/core/src/ingestor/pypi.ts`): parallel `pyproject.toml` + `requirements.txt` (good), then a sequential probe of `PYTHON_LOCK_FILE_NAMES` (`poetry.lock`, `Pipfile.lock`, `pdm.lock`); another 2–3 round-trip tail.
- **GoIngestor.parseDependencies** (`packages/core/src/ingestor/go.ts`): one GET for `go.mod`, then `GO_LOCK_FILE_NAMES = ["go.sum"]`; one extra round-trip.

A Go-only repo on a fresh run, with no cacheable state, currently pays the full npm probe (2–3 RTT) + the full pypi probe (2–3 RTT) before Go is ever tried. That is **4–6 wasted HTTP round-trips per Go repo**, and the same pattern in reverse for the other ecosystems. The waste compounds in two places:

- `scripts/ingest.js` line 290 — daily cron, every (re)ingested repo.
- `manifest-check.ts` line 109–116 — the user-facing submission pre-check, on the critical path of every repo submission POST.

The manifest pre-check has a 10-second shared transport timeout (`packages/core/src/ingestor/manifest-check.ts:69-73`); npm and pypi probes can each consume 2–4 of those seconds for a Go repo, leaving the actual Go probe to race the clock. The user-visible failure mode is "submission timed out" against a perfectly valid Go repo.

## Decision 1; Probe in parallel with priority-tie-break

`detectEcosystem()` launches every ingestor's `parseDependencies()` concurrently via `Promise.all`, with the caller's list order as the explicit tie-breaker. The function:

- **Fires every probe immediately** on entry; the caller is no longer charged for upstream probes' wasted RTTs.
- **Resolves to the first probe to settle with `manifest_resolved: true`**, with priority-tie-break on `caller-list order` (i.e. on the input array's index). A faster-but-lower-priority probe no longer wins against a slower-but-higher-priority one; the npm-first / pypi-second / go-third contract is preserved.
- **Aborts every in-flight probe** when the winner is determined, via an `AbortController` plumbed to each in-flight call. In-flight HTTP requests get an `AbortError` instead of completing-and-being-discarded. This is what actually saves the wasted RTTs that motivated the change: a still-open `fetch` connection gets closed at the OS level rather than continuing to make the round-trip.
- **Treats a thrown probe as unresolved**, exactly as today. A transport failure in one probe is converted to an `IngestorResult` with `manifest_resolved: false` and a warning, and probing continues. The new shape simply runs every probe's error-conversion in parallel; the per-probe behavior is unchanged.
- **Preserves the "combined warnings" output for the all-fail path**: every attempt's warnings, in caller-list order, on the same final result as today.

The priority-tie-break matters even though a true two-ecosystem-at-once repo is rare. (a) The current code is deterministic about which ecosystem "wins" on the unusual case; a future caller that orders `[GoIngestor, NpmIngestor, PyPIIngestor]` to test experimental ordering would expect the same determinism. (b) Without an explicit tie-break, the absolute-resolved-first wins by wall-clock latency, and a slow CI runner / a momentarily-slow CDN could flip which ecosystem gets recorded. The caller controls priority by the array order, not by parallelism.

### `AbortController` plumbing

The new shape accepts an `AbortSignal` from the caller (or builds one internally) and passes it down to each `parseDependencies()` call as a new optional second argument. Existing callers (`scripts/ingest.js`, `manifest-check.ts`) that don't pass a signal get the existing one-arg behavior — no breaking change. The `EcosystemIngestor` interface gains:

```ts
parseDependencies(repoPath: string, signal?: AbortSignal): Promise<IngestorResult>;
```

Per-ingestor implementation:

- NpmIngestor / PyPIIngestor / GoIngestor: forward the signal to the `fetchWithRetry` call for `package.json` / `pyproject.toml` / `requirements.txt` / `go.mod` and to the lock-file HEAD probes. `fetchWithRetry` already supports cancellation through its `AbortSignal`-aware `fetch` wrapper (ADR 0036).
- LocalNpmIngestor / LocalPyPIIngestor / LocalGoIngestor: accept the signal but treat it as a no-op (filesystem reads are not abortable in a useful way; the signal just causes the in-flight iteration to short-circuit at the next await). The CI and CLI paths are sequential today and unaffected; this is purely about not breaking the interface.

A thrown `AbortError` from a probe is caught and converted to the same `manifest_resolved: false` + warning shape as any other thrown probe — _unless_ the abort came from the orchestrator's own controller (i.e. the winner was already determined), in which case the abort is expected and the per-probe error is suppressed entirely (it never enters the warnings list).

## Decision 2; Orchestration helper, single-file change

The new logic lives entirely in `packages/core/src/ingestor/detect.ts`. The function's public signature is unchanged:

```ts
export async function detectEcosystem(
  ingestors: EcosystemIngestor[],
  repoPath: string,
): Promise<IngestorResult>;
```

A small internal helper (`runProbes(ingestors, repoPath, controller)`) drives the Promise.all + AbortController + priority-tie-break logic, keeping the main function focused on the public contract (empty-list guard, all-fail combination, warning ordering). No new modules, no new exports beyond what's needed for tests.

The `EcosystemIngestor` interface's `parseDependencies()` signature gains the optional second `signal` argument, but the default parameter value keeps every existing concrete ingestor source-compatible (TypeScript optional params don't force override updates at call sites; concrete classes can be updated independently to forward the signal).

## Decision 3; Test discipline: every existing case still passes, plus new tie-break and abort cases

`packages/core/src/ingestor/detect.test.ts` keeps every one of its 11 existing cases green (priority-tie, sequential-fall-through, throws-still-fall-through, empty-list, single-ingestor, warning-ordering). Six new cases cover the new behavior:

1. **npm + pypi both resolve, npm listed first** → npm wins; pypi probe's signal is aborted.
2. **npm + pypi both resolve, pypi listed first** → pypi wins; npm probe's signal is aborted.
3. **All three resolve concurrently** → exactly one winner; the other two signals aborted.
4. **npm throws, pypi throws, go resolves** → go wins, combined warnings carry the two throw notes.
5. **In-flight probe's `AbortError` is not surfaced as a warning** (orchestrator-initiated abort, not a transport failure).
6. **NpmIngestor-like real ingester forwards the signal** to its `fetch` calls (one test added to `npm.test.ts` that asserts an aborted call rejects with `AbortError` and does not write anything).

## What changed

- `packages/core/src/ingestor/detect.ts`; rewritten. New `runProbes()` helper, AbortController orchestration, priority-tie-break on caller-list index, all-fail path preserved.
- `packages/core/src/ingestor/interface.ts`; `EcosystemIngestor.parseDependencies(repoPath, signal?)`. The new param is optional at every existing call site.
- `packages/core/src/ingestor/npm.ts` / `pypi.ts` / `go.ts`; forward `signal` to the underlying `fetch`/`fetchWithRetry` calls for the manifest fetch and lock-file probes. The `Local*Ingestor` siblings accept the signal for interface conformance and ignore it (filesystem reads are not abortable).
- `packages/core/src/ingestor/detect.test.ts`; six new cases above; the existing 11 untouched (no behavior change at the assertions level — the public `IngestorResult` shape and the all-fail combination rules are preserved).
- `packages/core/src/ingestor/npm.test.ts`; one new case confirming the forwarded signal aborts an in-flight `fetch`.
- `CHANGELOG.md`; entry under `[Unreleased]`.

**No schema migration. No `/app` change. No `scripts/ingest.js` change. No `manifest-check.ts` change** (both call sites are source-compatible; the speedup is automatic). No new dependency, no new service, no breaking interface for callers.

## Consequences

- **Per-repo cron wall time drops by the cost of two failed upstream probes per repo that resolves on a non-first-listed ecosystem.** For a Go-only repo that previously burned 4–6 RTTs on npm + pypi before reaching Go, the new cost is the cost of the Go probe itself, plus the time for the abort signal to land and the upstream connections to close. Empirically this is a 3–6× reduction in detect-phase latency for the worst case; for a npm-first repo (the most common outcome), the change is essentially free — the npm probe is already in flight when pypi and go are launched, and pypi+go get aborted as soon as npm resolves.
- **User-facing submission POST latency drops** for any non-npm submission, where the manifest pre-check's 10-second shared transport timeout used to be the binding constraint.
- **No new failure mode.** Aborting an in-flight `fetch` is what `AbortController` exists for; a request that would have completed-and-been-discarded now completes-and-isn't-discarded. Network sockets close at the OS level instead of after the full response. No server-side harm; the upstream services (raw.githubusercontent.com, etc.) see aborted TCP connections, which they treat identically to any other client disconnect.
- **The behavior change is invisible to every caller** at the `IngestorResult` level. The only externally observable change is (a) lower latency for non-npm-first resolutions, and (b) the per-probe `AbortError` from a non-winning probe is not surfaced in `warnings[]` (it never reaches the final all-fail path either, because at least one probe resolved first in those cases).
- **Priority order on ties preserves every existing assumption.** A caller that lists `[npm, pypi, go]` and submits a hypothetical npm+go-only repo gets npm (today: also npm). A future caller that reorders to `[go, pypi, npm]` to test go-first would get go on the same repo (today: also go, since the first-listed wins). The new code is strictly faster at the same priority semantics.

## Alternatives considered

| Decision            | Alternative                                      | Why not                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parallelism         | `Promise.race` without priority tie-break        | A faster-but-lower-priority probe could win; changes today's deterministic "npm first" contract. Not worth the latency win for the rare multi-ecosystem repo, and a future experimental caller would have surprising semantics. |
| Cancellation        | No `AbortController`; let in-flight probes drain | Defeats the entire motivation. The wasted RTTs continue to be wasted; the change is then purely a measurement, not a real speedup.                                                                                              |
| Helper location     | New module `parallel-detect.ts`                  | Single function with a 30-line helper doesn't earn its own file; keeping it in `detect.ts` is consistent with the file's "this logic exists exactly once" header.                                                               |
| Interface change    | Always-pass `signal` (required, not optional)    | Would touch every existing call site and every mock in every test. The optional-parameter shape keeps the source-compatible path for callers that don't care.                                                                   |
| `manifest-check.ts` | Pass its own `AbortSignal` with a 10s deadline   | Could shave the timeout from "all probes combined" to "any single probe" today. Out of scope for this ADR — the call site still works; a follow-on can plumb the timeout signal in if the win is worth a separate change.       |

---

_End of document._
