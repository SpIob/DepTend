#!/usr/bin/env node
/**
 * One-time EPSS backfill (ADR 0039 follow-up).
 *
 * Advisories written before the EPSS enrichment stage shipped have
 * epss_score NULL — production had 0/172 populated on 2026-10-22, 50 of the
 * 51 unknown-severity rows being CVE-aliased. This script re-derives the
 * score for every advisory row (idempotent: only rows whose epss_score is
 * still NULL are touched, so re-running after a normal ingest is a no-op)
 * from the CVE aliases already stored in raw_data — no OSV re-fetch.
 *
 * Usage:
 *   node scripts/backfill-epss.mjs          # uses .env.local DATABASE_URL
 *   DRY_RUN=1 node scripts/backfill-epss.mjs  # report only, no writes
 *
 * Same driver discipline as scripts/ingest.js: neon-serverless (WebSocket)
 * because the UPDATE is a single round-trip and the pool must be closed
 * explicitly (neon-http would also work for stateless writes, but the
 * ingest.js precedent keeps one driver convention in scripts/).
 *
 * Env note: DATABASE_URL_UNPOOLED is NOT required here — this is DML, not
 * DDL; PgBouncer-safe.
 */

import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { DrizzleError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool } from "@neondatabase/serverless";
import { eq, isNull, and } from "drizzle-orm";
import * as schema from "../packages/core/dist/db/schema.js";
import { EpssFetcher, extractCveIds } from "../packages/core/dist/ingestor/epss.js";

function loadEnvLocal() {
  if (process.env.DATABASE_URL !== undefined || !existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    const key = match?.[1];
    if (match === null || key === undefined) continue;
    const raw = match[2] ?? "";
    if (process.env[key] === undefined) {
      process.env[key] = raw.replace(/^["']|["']$/g, "");
    }
  }
}
loadEnvLocal();

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  console.error("FATAL: DATABASE_URL is not set (env or .env.local).");
  process.exit(1);
}

const dryRun = process.env.DRY_RUN === "1";
const pool = new Pool({ connectionString: databaseUrl });
const db = drizzle(pool, { schema });

try {
  const pending = await db
    .select({
      id: schema.advisories.id,
      osvId: schema.advisories.osvId,
      rawData: schema.advisories.rawData,
    })
    .from(schema.advisories)
    .where(and(isNull(schema.advisories.epssScore)));

  console.log(`Advisories with NULL epss_score: ${String(pending.length)}`);

  const cveIds = extractCveIds(pending);
  console.log(`Unique CVE aliases among them: ${String(cveIds.length)}`);
  if (cveIds.length === 0) {
    console.log("Nothing to backfill.");
    process.exit(0);
  }

  const { scores, warnings } = await new EpssFetcher().fetchScores(cveIds);
  for (const warning of warnings) console.warn(`WARN: ${warning}`);
  console.log(`EPSS scores retrieved: ${String(scores.size)}`);

  let updated = 0;
  let unmatched = 0;
  for (const advisory of pending) {
    const rawData = advisory.rawData;
    const aliases =
      rawData !== null && typeof rawData === "object"
        ? /** @type {{ aliases?: unknown }} */ (rawData).aliases
        : undefined;
    if (!Array.isArray(aliases)) {
      unmatched++;
      continue;
    }
    const score = aliases
      .map((a) => (typeof a === "string" ? scores.get(a) : undefined))
      .find((s) => s !== undefined);
    if (score === undefined) {
      unmatched++;
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] ${advisory.osvId} -> epss ${String(score)}`);
      updated++;
      continue;
    }
    await db
      .update(schema.advisories)
      .set({ epssScore: score, updatedAt: new Date() })
      .where(eq(schema.advisories.id, advisory.id));
    updated++;
  }

  console.log(
    `${dryRun ? "[dry-run] would update" : "Updated"} ${String(updated)} advisory row(s); ` +
      `${String(unmatched)} left with no score (no CVE alias, or EPSS has no entry).`,
  );
  if (dryRun) {
    console.log("Dry run — no rows written. Re-run without DRY_RUN=1 to apply.");
  }
} catch (err) {
  console.error(
    "FATAL:",
    err instanceof DrizzleError || err instanceof Error ? err.message : String(err),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
