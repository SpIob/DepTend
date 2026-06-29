/**
 * @deptend/core — public API
 *
 * Only export what is intentionally part of the public surface.
 * Internal modules (db/, ingestor/, scorer/) are imported directly by
 * consumers that need them; they are not re-exported here to avoid
 * accidental coupling.
 */

export * from "./db/types.js";
