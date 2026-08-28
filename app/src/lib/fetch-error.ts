/**
 * Pull a human-readable error string out of an unknown JSON-parsed
 * response body. The shape `{ error: string }` is the convention every
 * mutating `/api/...` route in this app uses (see app/src/lib/responses.ts);
 * anything else — non-object, null, missing `error`, non-string `error` —
 * yields null so the caller can fall back to its own default message.
 *
 * Shared between the four client mutators (mission-card.tsx,
 * withdraw-button.tsx, bookmark-toggle.tsx, notification-toggle.tsx)
 * instead of each declaring an identical 5-line body (ponytail rung 2).
 */
export function extractErrorMessage(data: unknown): string | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  return typeof record.error === "string" ? record.error : null;
}
