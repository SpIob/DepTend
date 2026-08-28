/**
 * Shared type-guard helpers for the ingestor pipeline.
 *
 * Kept in their own file so every parser and local-* ingestor can narrow
 * the same shapes without each re-declaring an identical 1–3 line body
 * (ponytail rung 2 — already in this codebase, just extracted once).
 */

export function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Node fs errors carry a `code` string; narrow rather than trusting `any`. */
export function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
