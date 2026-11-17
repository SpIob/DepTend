/**
 * Pure helpers for notification UI logic.
 * Extracted for unit testing without jsdom/component test environment.
 */

export const ALLOWED_EVENT_TYPES = ["new_mission", "claimed", "resolved", "reopened"] as const;

export type AllowedEventType = (typeof ALLOWED_EVENT_TYPES)[number];

/**
 * Human-readable labels for each event type.
 * Exhaustive mapping — no silent default, TypeScript enforces coverage.
 */
export function eventTypeLabel(eventType: AllowedEventType): string {
  switch (eventType) {
    case "new_mission":
      return "New missions found";
    case "claimed":
      return "Someone claimed a mission";
    case "resolved":
      return "Mission resolved";
    case "reopened":
      return "Mission reopened";
  }
}

/**
 * Default event types for a new subscription — all four enabled.
 * Matches the column default in the DB migration plus "reopened"
 * (which the API accepts but the column default omitted).
 */
export function defaultEventTypes(): AllowedEventType[] {
  return [...ALLOWED_EVENT_TYPES];
}

/**
 * Check if an array contains exactly the default event types (order-insensitive).
 * Used to detect "no user customization" for potential UI optimizations.
 */
export function isDefaultEventTypes(eventTypes: string[]): boolean {
  if (eventTypes.length !== ALLOWED_EVENT_TYPES.length) return false;
  const defaultSet = new Set(ALLOWED_EVENT_TYPES);
  return eventTypes.every((et) => defaultSet.has(et as AllowedEventType));
}

/**
 * Validate a user-provided eventTypes array against the allow-list.
 * Mirrors the server-side validation in the subscribe route.
 */
export function validateEventTypes(value: unknown): AllowedEventType[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0 || value.length > ALLOWED_EVENT_TYPES.length) return null;
  if (
    !value.every(
      (entry) =>
        typeof entry === "string" && (ALLOWED_EVENT_TYPES as readonly string[]).includes(entry),
    )
  ) {
    return null;
  }
  return value as AllowedEventType[];
}
