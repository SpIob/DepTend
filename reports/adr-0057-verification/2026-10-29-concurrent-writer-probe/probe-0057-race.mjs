// ADR 0057 verification — Phase 2: end-to-end concurrent MissionWriter race
// on dev Neon, using the REAL built writer (packages/core/dist) and the real
// drizzle neon-serverless setup, exactly as scripts/ingest.js wires it.
//
// Steps:
//   1. Record pre-state (mission/score counts for the fixture + dev totals).
//   2. Clear the fixture's regenerable missions + scores (dev-only synthetic
//      fixture; recreated by the very code under test).
//   3. Launch 10 CONCURRENT generateMissionsForRepo() calls (the ADR's
//      load-test claim: "10 concurrent ingestion runs — exactly one set").
//   4. Assert post-state: exactly 8 missions, distinct (dep, advisory, type)
//      triples = 8, 8 score rows, sum(created across writers) = 8.
//   5. One sequential re-run afterwards: expect created=0, updated=8,
//      resolved=0 (re-run safety contract, ADR 0008 §2).
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const REPO_ROOT = "/Users/spiob/Coding Projects/DepTend/Source";
const require = createRequire(REPO_ROOT + "/package.json");
const { Pool, neonConfig } = require("@neondatabase/serverless");
const { drizzle } = require("drizzle-orm/neon-serverless");
neonConfig.webSocketConstructor = globalThis.WebSocket;

const schema = await import(pathToFileURL(REPO_ROOT + "/packages/core/dist/db/schema.js").href);
const { MissionWriter } = await import(
  pathToFileURL(REPO_ROOT + "/packages/core/dist/scorer/writer.js").href
);

const REPO_ID = "ce0de2e0-f8c5-4889-9135-6ee1ae40d0b2"; // deptend-pypi-test-fixture

const cs = process.env.DATABASE_URL;
if (!cs) {
  console.error("DATABASE_URL missing (pass via --env-file)");
  process.exit(1);
}

const pool = new Pool({ connectionString: cs });
const out = {};

const pre = await pool.query(
  `SELECT
     (SELECT count(*)::int FROM missions WHERE repo_id = $1) AS fixture_missions,
     (SELECT count(*)::int FROM mission_scores s JOIN missions m ON m.id = s.mission_id WHERE m.repo_id = $1) AS fixture_scores,
     (SELECT count(*)::int FROM missions) AS dev_total_missions`,
  [REPO_ID],
);
out.preState = pre.rows[0];

// 2. Clear the fixture's regenerable mission data.
await pool.query(
  `DELETE FROM mission_scores WHERE mission_id IN (SELECT id FROM missions WHERE repo_id = $1)`,
  [REPO_ID],
);
await pool.query(`DELETE FROM missions WHERE repo_id = $1`, [REPO_ID]);
const cleared = await pool.query(`SELECT count(*)::int AS c FROM missions WHERE repo_id = $1`, [
  REPO_ID,
]);
out.clearedTo = cleared.rows[0].c;

// 3. Ten concurrent REAL writer runs.
const db = drizzle(pool, { schema });
const writer = new MissionWriter(db);
const runOne = async (i) => {
  const t = Date.now();
  try {
    const r = await writer.generateMissionsForRepo(REPO_ID);
    return {
      writer: i,
      ms: Date.now() - t,
      created: r.created,
      updated: r.updated,
      resolved: r.resolved,
      candidatesFound: r.candidatesFound,
      warnings: r.warnings.length,
    };
  } catch (e) {
    return {
      writer: i,
      ms: Date.now() - t,
      error: String((e && e.message) || e),
      pg_code: (e && e.code) || null,
    };
  }
};

const t0 = Date.now();
const writers = await Promise.all(Array.from({ length: 10 }, (_, i) => runOne(i)));
out.raceMs = Date.now() - t0;
out.writers = writers;

const sumCreated = writers.reduce(
  (acc, w) => acc + (typeof w.created === "number" ? w.created : 0),
  0,
);
const errors = writers.filter((w) => w.error);
out.summary = { sumCreated, errors: errors.length };

// 4. Post-state assertions.
const post = await pool.query(
  `SELECT
     count(*)::int AS rows,
     count(DISTINCT (dependency_id, coalesce(advisory_id::text, '-'), mission_type))::int AS distinct_triples,
     (SELECT count(*)::int FROM mission_scores s JOIN missions m ON m.id = s.mission_id WHERE m.repo_id = $1) AS scores,
     (SELECT count(*)::int FROM missions) AS dev_total_missions
   FROM missions WHERE repo_id = $1`,
  [REPO_ID],
);
out.postState = post.rows[0];
out.assertions = {
  exactlyOneSet: post.rows[0].rows === 8 && post.rows[0].distinct_triples === 8,
  scoresComplete: post.rows[0].scores === 8,
  exactlyOneCreator: sumCreated === 8,
  noWriterErrors: errors.length === 0,
};

// 5. Sequential re-run safety.
const rerun = await runOne("sequential-rerun");
out.rerun = rerun;
out.rerunAssertions = {
  createdZero: rerun.created === 0,
  updatedAll: rerun.updated === 8,
  resolvedZero: rerun.resolved === 0,
};

console.log("PHASE2_RESULT " + JSON.stringify(out, null, 2));
await pool.end().catch(() => {});
process.exit(0);
