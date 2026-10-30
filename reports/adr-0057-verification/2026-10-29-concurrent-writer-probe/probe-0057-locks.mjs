// ADR 0057 verification — Phase 1: pg_advisory_xact_lock mechanics on dev Neon.
// Two real concurrent sessions over @neondatabase/serverless (the driver the
// real pipeline uses). No data changes: BEGIN/ROLLBACK only.
import { createRequire } from "node:module";

const require = createRequire("/Users/spiob/Coding Projects/DepTend/Source/package.json");
const { Client, neonConfig } = require("@neondatabase/serverless");
neonConfig.webSocketConstructor = globalThis.WebSocket;

const REPO_ID = "ce0de2e0-f8c5-4889-9135-6ee1ae40d0b2"; // deptend-pypi-test-fixture
const OTHER_ID = "11111111-2222-3333-4444-555555555555"; // different lock key

const cs = process.env.DATABASE_URL;
if (!cs) {
  console.error("DATABASE_URL missing (pass via --env-file)");
  process.exit(1);
}

const a = new Client({ connectionString: cs });
const b = new Client({ connectionString: cs });
await a.connect();
await b.connect();

const out = {};

// 0. Record the hash keys (evidence artifact).
const hashes = await a.query(
  "SELECT hashtext($1)::text AS repo_key_hash, hashtext($2)::text AS other_key_hash",
  [REPO_ID, OTHER_ID],
);
out.hashes = hashes.rows[0];

// 1. A takes the transaction-scoped lock and HOLDS the transaction open.
await a.query("BEGIN");
await a.query("SELECT pg_advisory_xact_lock(hashtext($1))", [REPO_ID]);
const lockView = await a.query(
  "SELECT locktype, objid::text AS key_hash, granted FROM pg_locks WHERE locktype = 'advisory'",
);
out.lockWhileHeld = lockView.rows;

// 2. B attempts the SAME key under a transaction-pinned 4s statement timeout.
//    Expect: cancel (57014) after ~4s — proving the lock blocks others.
await b.query("BEGIN");
const t0 = Date.now();
try {
  await b.query("SET LOCAL statement_timeout = '4s'");
  await b.query("SELECT pg_advisory_xact_lock(hashtext($1))", [REPO_ID]);
  out.blockedSameKey = { result: "UNEXPECTED: acquired while A holds it" };
} catch (e) {
  out.blockedSameKey = {
    result: "blocked",
    pg_code: e.code ?? null,
    message: e.message,
    waited_ms: Date.now() - t0,
  };
} finally {
  await b.query("ROLLBACK").catch(() => {});
}

// 3. B takes a DIFFERENT key while A still holds — expect immediate success
//    (per-repo key granularity, no global contention).
const t1 = Date.now();
try {
  await b.query("SELECT pg_advisory_xact_lock(hashtext($1))", [OTHER_ID]);
  out.otherKeyUnaffected = { result: "acquired", waited_ms: Date.now() - t1 };
} catch (e) {
  out.otherKeyUnaffected = {
    result: "failed",
    pg_code: e.code ?? null,
    waited_ms: Date.now() - t1,
  };
}

// 4. A rolls back -> lock auto-released on txn end. B retries: instant.
await a.query("ROLLBACK");
const t2 = Date.now();
try {
  await b.query("SELECT pg_advisory_xact_lock(hashtext($1))", [REPO_ID]);
  out.afterReleaseInstant = { result: "acquired", waited_ms: Date.now() - t2 };
} catch (e) {
  out.afterReleaseInstant = {
    result: "failed",
    pg_code: e.code ?? null,
    waited_ms: Date.now() - t2,
  };
}

// 5. Positive wait (the writer's actual reliance): A holds; B starts a
//    blocking acquire with NO timeout; A releases ~1.2s later; B must
//    PROCEED (not error), with waited_ms ≈ 1200.
await a.query("BEGIN");
await a.query("SELECT pg_advisory_xact_lock(hashtext($1))", [REPO_ID]);
const t3 = Date.now();
const waitP = b
  .query("SELECT pg_advisory_xact_lock(hashtext($1))", [REPO_ID])
  .then(() => Date.now() - t3)
  .catch((e) => -1);
await new Promise((r) => setTimeout(r, 1200));
await a.query("ROLLBACK");
out.waitedThenAcquired = { waited_ms: await waitP };

console.log("PHASE1_RESULT " + JSON.stringify(out, null, 2));
await a.end().catch(() => {});
await b.end().catch(() => {});
process.exit(0);
