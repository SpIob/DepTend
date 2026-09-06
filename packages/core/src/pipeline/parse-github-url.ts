/**
 * GitHub URL parsing — shared pipeline module
 *
 * Re-exports parseGithubUrl from @deptend/core/db/repos.js so that
 * both scripts/ingest.js and other consumers can import from a single
 * public path without depending on internal db module structure.
 */

export { parseGithubUrl } from "../db/repos.js";
