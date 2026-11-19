# SARIF → GitHub code scanning round-trip (issue #34 acceptance)

**Date:** 2026-11-18/19 (run 2026-11-19T00:00Z) · **Result: PASS, after catching one real contract bug**

## What ran

A scratch **public** repo (`SpIob/deptend-sarif-scratch`, deleted after the run) with:

- a `package.json` pinning two vulnerable deps (`lodash@4.17.15`, `minimist@1.2.0`);
- a workflow (preserved here as `sarif.yml`) that checks out SpIob/DepTend, builds the CLI **from source** (`pnpm --filter @deptend/cli build` — the npm-published 0.1.2 predates `--format sarif`), scans the scratch repo itself (`node deptend/cli/dist/index.js . --format sarif --output results.sarif`), and uploads via `github/codeql-action/upload-sarif@v3` with `GITHUB_TOKEN` (free on public repos; zero DepTend infrastructure).

## First attempt: the round-trip caught a real bug

The first upload **failed** at GitHub's SARIF validator:

```
Error details: instance.runs[0].columnKind is not one of enum values: utf16CodeUnits,unicodeCodePoints
```

The formatter emitted `columnKind: "utf16"` — and the unit test asserted that exact wrong value, so the full local gate was green while the real contract failed. This is the AGENTS §6 meta-lesson once more (mocks passed, live contract failed). Fixed in `0e7e762` (2026-11-18): `"utf16CodeUnits"` + a closed-enum assertion in `cli/src/format/sarif.test.ts`.

## Successful run (evidence in this directory)

- `workflow-log.txt` — the full Actions log of run [44425405975](https://github.com/SpIob/deptend-sarif-scratch/actions/runs/44425405975). Key lines:
  - `Using https://github.com/SpIob/deptend-sarif-scratch from origin remote` — the CLI's `--github-url` auto-detect (#32) working in CI.
  - `✓ Wrote 12 mission(s) to results.sarif`
  - `Validating results.sarif` → `Successfully uploaded results` → `Analysis upload status is complete.`
- `code-scanning-alerts.json` — `GET /repos/SpIob/deptend-sarif-scratch/code-scanning/alerts` returns **12 open alerts**, one per advisory, ruleIds = GHSA ids, all located at `package.json:1` (the CLI's `artifactLocation.uri` + `%SRCROOT%` resolving correctly).
- `sarif.yml` — the workflow as run.
- `job-summary.json` — all nine steps green.

## Follow-up noted (not blocking)

GitHub shows the alerts without a security-severity classification because the CLI's SARIF rules don't carry the `security-severity` property GitHub uses to bucket Critical/High/Medium/Low in the UI. The alerts are correct and queryable; adding `security-severity` (derived from `severityToSarifLevel`) is a small future enhancement if code-scanning presentation ever matters.
