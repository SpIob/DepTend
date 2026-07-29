/**
 * Shared UUID-shape validation for route params before they reach a
 * guarded DB write.
 *
 * Originally lived as isValidMissionId() inside db/missions.ts. Extracted
 * here per ADR 0027 once db/bookmarks.ts needed the identical check for
 * repo IDs — missions.ts now re-exports isValidMissionId as an alias so
 * existing callers (the claim/unclaim API routes) are unaffected.
 *
 * Without this check, a malformed ID reaches Postgres as a raw "invalid
 * input syntax for type uuid" error instead of a clean 400 at the API
 * boundary.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(id: string): boolean {
  return UUID_PATTERN.test(id);
}
