/**
 * Shared DB type aliases used across the writer layer.
 *
 * `DbOrTx` collapses to one alias the two otherwise-identical copies of
 * `AnyNeonDb` / `AnyNeonTx` that used to live at the top of
 * packages/core/src/ingestor/writer.ts and
 * packages/core/src/scorer/writer.ts — byte-for-byte identical aliases,
 * each gated by its own `// eslint-disable-next-line no-explicit-any`
 * because Drizzle's `NeonDatabase<TSchema>` generic requires `<any>`
 * to accept a generic schema without dragging the whole schema type
 * into every method signature. One disable comment now, one
 * canonical type.
 *
 * The same shape is also used in db/organizations.ts's own
 * `DrizzleDb` (which intentionally types the HTTP driver too — that
 * one stays local to organizations.ts since it's the only file
 * that needs the HTTP-vs-WebSocket union, and adding it here would
 * force every other consumer of DbOrTx to import that distinction).
 */

import type { NeonDatabase, NeonTransaction } from "drizzle-orm/neon-serverless";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNeonDb = NeonDatabase<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNeonTx = NeonTransaction<any, any>;

/** Accepts both the outer db instance and the transaction callback parameter. */
export type DbOrTx = AnyNeonDb | AnyNeonTx;
