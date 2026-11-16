# ADR 0067: The Packaged CLI's Entry Gate Must Resolve Symlinks

**Status:** Accepted (fixed and live-verified against the published package 2026-11-16; regression test + gate extraction ship as 0.1.2)
**Date:** 2026-11-16

---

## Context

`@deptend/cli` was published to npm on 2026-11-16 (version 0.1.0, then 0.1.1). The first invocation of the **published** package exposed a defect that every pre-publish check in ADR 0065 had passed:

```
$ npx --yes @deptend/cli@0.1.0 --help
$ echo $?
0
```

Exit 0, **zero bytes of output**. The command that is the package's entire reason for existing did nothing, successfully.

**Root cause.** The module-entry gate in `cli/src/index.ts` compared two path strings that are not the same string under the package's normal invocation:

```ts
const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === fileURLToPath(`file://${process.argv[1]}`);
```

An installed package is reached through the bin shim npm creates — `node_modules/.bin/deptend`, a symlink to `../@deptend/cli/dist/index.js`:

- `process.argv[1]` is the **symlink path** as invoked (`…/node_modules/.bin/deptend`).
- `import.meta.url` is the **real file** behind it (Node resolves the entry module's symlinks by default; `--preserve-symlinks-main` is not set).

The two strings never match, so `isMainModule` is false, `main()` is never called, and the process exits 0 having printed nothing. Measured directly, on the same paths npm produces:

```
argv1     …/gate-proof-XXXX/.bin/deptend          (symlink)
moduleUrl file:///…/gate-proof-XXXX/index.js      (real file)
old gate  false     ← 0.1.0
new gate  true      ← fix
```

**Why the ADR 0065 verification missed it, and why that is the reusable lesson.** ADR 0065's verification pass did install the packed tarball into a clean directory and run it — but it exercised the tarball through its **real file path** equivalently, one that cannot fail this gate. The bin shim, which is the only path an actual `npx` user takes, was never exercised. "Verified the artifact" is not the same claim as "verified the artifact through its published entry point": a bundle can be correct byte-for-byte and still be unreachable.

The failure mode compounds this: because the gate is a silent `false` rather than an error, `npm install` succeeds, `--help` exits 0, and CI running `node dist/index.js` stays green. Only a human running the installed command sees it.

## Decision 1: Resolve both sides of the gate before comparing

```ts
export function isEntryPoint(entryPath: string | undefined, moduleUrl: string): boolean {
  if (entryPath === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryPath);
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main().catch(/* … */);
}
```

`realpathSync` on both sides collapses the symlink and the real file to the same path, so the gate is true under every invocation: the bin shim, `node dist/index.js`, a global install, and a direct `node_modules/@deptend/cli/dist/index.js` call. A path that cannot be resolved (deleted, or `argv[1]` absent) is **not** the entry point — hence `false`, not a thrown error, so an unresolvable path can never crash the module on import.

This matches the repo's existing `scripts/ingest.js` gate pattern in shape; the difference is that `ingest.js` is always reached by its real path, so it never needed symlink resolution.

## Decision 2: Extract the gate into an exported, unit-tested predicate

The gate was an inline module-level `const`, which made it untestable: any test that imports the module to observe the gate trips the gate. Extracting `isEntryPoint(entryPath, moduleUrl)` as a pure predicate makes the exact defect reproducible in a temp directory — a real file, a real symlink pointing at it, and both path forms passed in — with no subprocess, no build, and no published package:

```ts
it("returns true when reached through the bin symlink (0.1.0 regression)", () => {
  expect(isEntryPoint(binLinkPath, pathToFileURL(modulePath).href)).toBe(true);
});
```

This assertion **fails against the 0.1.0 implementation and passes against the fix** (verified both ways, not assumed) — the shape AGENTS.md §13 calls for from the `ingest.js` regression test.

## Consequences

**Verified (2026-11-16), all against the published package, none against `src/`:**

- `npx --yes @deptend/cli@0.1.0 --help` → exit 0, 0 bytes. `@deptend/cli@0.1.1 --help` → exit 0, 512 bytes of usage.
- Full analysis run through the published 0.1.1 against live infrastructure — `npx @deptend/cli <repo> --github-url https://github.com/SpIob/DepTend` → 7 ranked missions written, exit 0, with live GitHub repo metadata (stars, open-issue count) in the output.
- Gate evaluated both ways on identical paths: old `false`, new `true`.
- `cli/src/index.test.ts` 18/18 green; repo `typecheck`, `lint`, `format:check` green.

**Costs accepted:**

- Two patch releases in one day (0.1.1 for the behavioral fix, 0.1.2 for the gate extraction + test) so the published artifact and `main` do not diverge. 0.1.0 remains on the registry as an untagged, broken version — npm's 72-hour unpublish window makes removal optional, and `latest` never pointed at it after 0.1.1.
- The gate now performs two `realpathSync` syscalls at module load. Measured cost is negligible against a CLI that immediately performs network I/O.

**Not resolved here:**

- Nothing verifies the **published** artifact in CI. The only guard against this class of defect is still a human running the installed package. A post-publish smoke job (`npx @deptend/cli@latest --help` asserting non-empty output, run on release) would close it; it needs a release workflow that does not exist yet.
- `0.0.0-stage` sits on the registry from the packaging rehearsal. It is not `latest` and carries no dist-tag; ignore it.

## Rollback

Revert `cli/src/index.ts` to the inline unresolved comparison and delete the `isEntryPoint` block from `cli/src/index.test.ts`. The published versions 0.1.1/0.1.2 cannot be un-published after 72 hours, so a rollback would need a new patch release — which is itself the argument for keeping the fix.
