#!/usr/bin/env node
/**
 * One-time backfill: populate the `organizations` table and set
 * `repos.org_id` for every existing repo whose `org_id IS NULL`
 * (ADR 0047).
 *
 * Why this script exists: DepTend's ingestion pipeline historically
 * only pulled dependency data, not GitHub-side org metadata, so
 * `repos.org_id` was always NULL on first ingest. The pipeline now
 * pulls org metadata for every newly-ingested repo (see
 * scripts/ingest.js). But all the repos that were ingested before
 * that change still have NULL `org_id`, and the per-org directory
 * page (/org/[org]) only renders for orgs that have at least one
 * repo linked. This script walks those stale rows once and backfills
 * them.
 *
 * Idempotent: upsertOrganization is a no-op for orgs that already
 * exist, and the writer's repos.orgId update is `WHERE id = $1`
 * against the same row each time. Re-running after a partial failure
 * is safe.
 *
 * Rate-limit aware: pulls GITHUB_TOKEN from env (matches
 * scripts/ingest.js). At 5,000 req/hr authenticated, the backfill
 * finishes in seconds; unauthenticated (60 req/hr), it caps at ~24
 * orgs/minute and is only practical for small datasets.
 *
 * Usage:
 *   node scripts/backfill-orgs.mjs
 *
 * Exit codes:
 *   0  All targeted repos processed successfully.
 *   1  Fatal startup error or a repo failure that wasn't recoverable.
 *
 * ADR: docs/adr/0047-populate-organizations.md
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { isNull, eq as eqOp } from "drizzle-orm";
import * as schema from "../packages/core/dist/db/schema.js";
import {
  lookupGitHubOwnerMeta,
  GitHubOrgMetaError,
} from "../packages/core/dist/ingestor/github-org-meta.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL === undefined || DATABASE_URL === "") {
  console.error("Error: DATABASE_URL is not set.");
  process.exit(1);
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? null;
if (GITHUB_TOKEN === null) {
  console.warn(
    "Warning: GITHUB_TOKEN is not set. Running unauthenticated at 60 req/hr; " +
      "backfill will be slow on large datasets.",
  );
}

const sqlClient = neon(DATABASE_URL);
const db = drizzle(sqlClient, { schema });

// Find every repo with a NULL org_id.
const targets = await db
  .select({ id: schema.repos.id, owner: schema.repos.owner, name: schema.repos.name })
  .from(schema.repos)
  .where(isNull(schema.repos.orgId));

console.log(`Found ${targets.length} repos with no org_id.`);

let succeeded = 0;
let skipped = 0;
let failed = 0;

for (const repo of targets) {
  try {
    const owner = repo.owner ?? "";
    if (owner === "") {
      console.warn(`  - skip ${repo.id}: owner is empty`);
      skipped++;
      continue;
    }

    const org = await lookupGitHubOwnerMeta(owner, GITHUB_TOKEN);
    const [row] = await db
      .insert(schema.organizations)
      .values({
        githubLogin: org.login,
        name: org.name,
        avatarUrl: org.avatarUrl,
      })
      .onConflictDoUpdate({
        target: schema.organizations.githubLogin,
        set: {
          name: org.name,
          avatarUrl: org.avatarUrl,
          updatedAt: new Date(),
        },
      })
      .returning({ id: schema.organizations.id });
    const orgId = row?.id;
    if (orgId === undefined) {
      console.error(`  - fail ${repo.owner}/${repo.name}: org upsert returned no id`);
      failed++;
      continue;
    }
    await db.update(schema.repos).set({ orgId }).where(eqOp(schema.repos.id, repo.id));
    console.log(`  + ${repo.owner}/${repo.name} -> ${org.login} (orgId=${orgId})`);
    succeeded++;
  } catch (err) {
    if (err instanceof GitHubOrgMetaError) {
      console.warn(`  - skip ${repo.owner}/${repo.name}: ${err.kind} (${err.message})`);
      skipped++;
    } else {
      console.error(
        `  - fail ${repo.owner}/${repo.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      failed++;
    }
  }
}

console.log(`\nBackfill complete. succeeded=${succeeded} skipped=${skipped} failed=${failed}`);

if (failed > 0) {
  process.exit(1);
}
