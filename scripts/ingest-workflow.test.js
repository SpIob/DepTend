/**
 * Regression test for the ingest workflow's pre-flight DB connectivity check
 * (.github/workflows/ingest.yml, pre-flight step #6).
 *
 * On 2026-09-24 08:57 UTC, the daily ingest cron (run 35978272261) failed in
 * the Pre-flight validation step, before ingestion started. The check calls
 * the Neon client conventionally:
 *
 *   const sql = neon(process.env.DATABASE_URL);
 *   sql('SELECT 1').then(...)
 *
 * but @neondatabase/serverless >=1.0 removed the conventional-call API — the
 * exported function is tagged-template-only and throws at runtime:
 *
 *   Error: This function can now be called only as a tagged-template function:
 *   sql`SELECT ${value}`, not sql("SELECT $1", [value], options).
 *   For a conventional function call with value placeholders ($1, $2, etc.),
 *   use sql.query("SELECT $1", [value], options).
 *
 * node --check and shell syntax checks are silent on this class of bug (the
 * YAML is valid; the JS only throws when executed), so the regression test
 * mirrors scripts/ingest.test.js's design: extract the exact `node -e` snippet
 * from the workflow file and execute it against a stub that matches the real
 * 1.1.0 API shape — sql.query() resolves, a conventional sql() call throws.
 *
 * Why a workflow-file test lives in scripts/ as .js:
 *   - scripts/ingest.test.js established the colocated-regression-test
 *     convention for the ingestion pipeline; this file sits beside it.
 *   - Plain JS keeps the project's ESLint config from typed-linting over a
 *     JS-only directory (same rationale as ingest.test.js's header).
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const WORKFLOW_URL = new URL("../.github/workflows/ingest.yml", import.meta.url);

/** Extract the full pre-flight `node -e "..." || exit 1` region (shell line included). */
function extractPreflightDbCheck() {
  const yml = readFileSync(WORKFLOW_URL, "utf8");
  const match = yml.match(/node -e "[\s\S]*?" \|\| exit 1/);
  return match === null ? null : match[0];
}

/** The JS body a region's `node -e "` wrapper actually hands to node. */
function jsBodyOf(region) {
  const start = region.indexOf('"') + 1;
  const end = region.lastIndexOf('" || exit 1');
  return region.slice(start, end).trim();
}

/**
 * A require() stub matching the real @neondatabase/serverless 1.1.0 API
 * shape (verified empirically against the installed package): neon(url)
 * returns a function that THROWS when called conventionally and exposes
 * sql.query() as the only conventional-call entry point.
 */
function stubRequire(calls) {
  return (id) => {
    calls.requires.push(id);
    if (id !== "@neondatabase/serverless") {
      throw new Error(`unexpected require: ${id}`);
    }
    return {
      neon: (url) => {
        calls.neonUrls.push(url);
        if (!url) {
          throw new Error("neon() requires a connection string");
        }
        const sql = (_q) => {
          throw new Error("This function can now be called only as a tagged-template function");
        };
        sql.query = (q) => {
          calls.queries.push(q);
          return Promise.resolve({ rows: [{ ok: 1 }] });
        };
        return sql;
      },
    };
  };
}

/** Run the snippet in a sandbox, capturing console output and exit calls. */
async function runSnippet(code) {
  const calls = { requires: [], neonUrls: [], queries: [], exits: [], logs: [] };
  const sandbox = {
    require: stubRequire(calls),
    process: {
      env: { DATABASE_URL: "postgresql://stub.invalid/db" },
      exit: (c) => calls.exits.push(c),
    },
    console: {
      log: (...args) => calls.logs.push(args.map(String).join(" ")),
      error: (...args) => calls.logs.push(args.map(String).join(" ")),
    },
  };
  vm.runInNewContext(code, sandbox);
  // The promise chain resolves on a later tick; give it one.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return calls;
}

describe("ingest.yml pre-flight DB connectivity check", () => {
  it("exists as a node -e block with a failure exit", () => {
    const code = extractPreflightDbCheck();
    expect(code).not.toBeNull();
    expect(code).toContain("|| exit 1");
  });

  it("uses the tagged-template-only driver via sql.query(), not the removed conventional call", () => {
    const code = extractPreflightDbCheck();
    expect(code).not.toBeNull();
    const normalized = code.replace(/\s+/g, " ");
    // The exact shape that killed run 35978272261 — must never reappear.
    expect(normalized).not.toMatch(/sql\s*\(\s*['"`]/);
    expect(normalized).toContain("require('@neondatabase/serverless')");
    expect(normalized).toContain("sql.query(");
  });

  it("reads the connection string from the environment, not a hardcoded URL", () => {
    const code = extractPreflightDbCheck();
    expect(code).not.toBeNull();
    const normalized = code.replace(/\s+/g, " ");
    expect(normalized).toContain("neon(process.env.DATABASE_URL)");
    expect(normalized).not.toMatch(/neon\(['"]postgresql:/);
  });

  it("executes end-to-end against the real 1.1.0 API shape: query runs, DB check logs OK, no early exit", async () => {
    const code = extractPreflightDbCheck();
    expect(code).not.toBeNull();
    const calls = await runSnippet(jsBodyOf(code));
    expect(calls.requires).toEqual(["@neondatabase/serverless"]);
    expect(calls.neonUrls).toEqual(["postgresql://stub.invalid/db"]);
    expect(calls.queries).toEqual(["SELECT 1"]);
    expect(calls.exits).toEqual([]);
    expect(calls.logs).toContain("DB connection OK");
  });
});
