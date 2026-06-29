#!/usr/bin/env node
/**
 * scripts/ingest.js
 *
 * Data ingestion job entrypoint. Runs in GitHub Actions on a cron schedule
 * or on manual trigger. Plain JavaScript (TypeScript is not required in /scripts).
 *
 * Usage:
 *   node scripts/ingest.js --triggered-by cron
 *   node scripts/ingest.js --triggered-by manual --repo-id <uuid>
 *
 * Implemented in Phase 1. This file is a placeholder that exits cleanly.
 */

const args = process.argv.slice(2);
const triggeredBy = args[args.indexOf("--triggered-by") + 1] ?? "manual";
const repoId = args.includes("--repo-id") ? args[args.indexOf("--repo-id") + 1] : null;

console.log(`[ingest] triggered-by=${triggeredBy} repo-id=${repoId ?? "all"}`);
console.log("[ingest] Ingestion pipeline not yet implemented (Phase 1). Exiting.");

// Exit 0 so the workflow step does not fail during Phase 0.
process.exit(0);
