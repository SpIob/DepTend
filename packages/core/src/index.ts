/**
 * @deptend/core — public API
 *
 * Only export what is intentionally part of the public surface.
 * Internal modules (db/, ingestor/, scorer/) are imported directly by
 * consumers that need them; they are not re-exported here to avoid
 * accidental coupling.
 */

// type-only: schema.ts also exports pgTable/pgEnum runtime objects, which
// stay internal per this file's own rule above — /app imports those
// directly from db/schema.js when it needs to build queries.
export type * from "./db/schema.js";
export * from "./db/json-types.js";
export * from "./db/query-types.js";
