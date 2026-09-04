// One-off diagnostic script. Run from packages/core/ via:
//   node --experimental-specifier-resolution=node scripts/check-advisory.mjs
// (or `node scripts/check-advisory.mjs` after build).
import { drizzle } from "drizzle-orm/neon-serverless";
import { neon } from "@neondatabase/serverless";
import { config } from "dotenv";
import { eq } from "drizzle-orm";
import * as schema from "../dist/db/schema.js";

config({ path: "../../.env.local" });
const url = process.env.DATABASE_URL;
const sql = neon(url);
const db = drizzle(sql, { schema });

const OSV_ID = "GHSA-www2-v7xj-xrc6";

const adv = await db.select().from(schema.advisories).where(eq(schema.advisories.osvId, OSV_ID));
console.log("== advisory row ==");
console.log(JSON.stringify(adv, null, 2));

const m = await db
  .select({
    mission: schema.missions,
    score: schema.missionScores,
    repo: {
      owner: schema.repos.owner,
      name: schema.repos.name,
      stars: schema.repos.stars,
      openIssues: schema.repos.openIssuesCount,
    },
    dep: {
      pkg: schema.dependencies.packageName,
      versionSpec: schema.dependencies.versionSpec,
      depType: schema.dependencies.depType,
      latest: schema.dependencies.latestVersion,
      resolved: schema.dependencies.resolvedVersion,
    },
  })
  .from(schema.missions)
  .innerJoin(schema.missionScores, eq(schema.missionScores.missionId, schema.missions.id))
  .innerJoin(schema.repos, eq(schema.missions.repoId, schema.repos.id))
  .leftJoin(schema.dependencies, eq(schema.missions.dependencyId, schema.dependencies.id))
  .leftJoin(schema.advisories, eq(schema.missions.advisoryId, schema.advisories.id))
  .where(eq(schema.advisories.osvId, OSV_ID));
console.log("== mission+score rows (n=" + m.length + ") ==");
for (const r of m) {
  console.log("---");
  console.log(
    "repo:",
    r.repo.owner + "/" + r.repo.name,
    "stars=" + r.repo.stars,
    "issues=" + r.repo.openIssues,
  );
  console.log("mission:", r.mission.title, "status=" + r.mission.status);
  console.log("score.composite_score:", r.score.compositeScore);
  console.log("score.impact_score:", r.score.impactScore);
  console.log("score.ecosystem_value_score:", r.score.ecosystemValueScore);
  console.log("score.effort_label:", r.score.effortLabel);
  console.log("score.confidence:", r.score.confidence);
  console.log("score.scoring_version:", r.score.scoringVersion);
  console.log("score.createdAt:", r.score.createdAt);
  console.log("score.updatedAt:", r.score.updatedAt);
  console.log("impact_inputs:", JSON.stringify(r.score.impactInputs, null, 2));
  console.log("ecosystem_value_inputs:", JSON.stringify(r.score.ecosystemValueInputs, null, 2));
  console.log("effort_inputs:", JSON.stringify(r.score.effortInputs, null, 2));
  console.log("confidence_flags:", JSON.stringify(r.score.confidenceFlags, null, 2));
  console.log("confidence_notes:", JSON.stringify(r.score.confidenceNotes, null, 2));
  console.log("dep:", r.dep);
}
