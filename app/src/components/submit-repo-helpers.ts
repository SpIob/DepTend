/**
 * Pure helpers for submit-repo-form notification opt-in logic.
 * Extracted for unit testing without jsdom/component test environment.
 */

import type { AllowedEventType } from "./notification-helpers";

/**
 * The event types to subscribe to when the submitter opts in.
 * Per issue #44, this is only "new_mission".
 */
export const SUBMITTER_OPTIN_EVENT_TYPES: AllowedEventType[] = ["new_mission"];

/**
 * Message to show when submission succeeds and the opt-in was UNCHECKED.
 * Informs the user they can enable notifications later.
 */
export const SUCCESS_MESSAGE_UNCHECKED_SUFFIX =
  " You can turn on new-mission notifications from the repo page.";

/**
 * Message to show when submission succeeds and the opt-in was CHECKED
 * and the subscription succeeded.
 */
export const SUCCESS_MESSAGE_CHECKED_SUBSCRIBED = " Subscribed to new-mission notifications.";

/**
 * Message to show when submission succeeds and the opt-in was CHECKED
 * but the subscription failed (non-fatal — submission still succeeded).
 */
export const SUCCESS_MESSAGE_CHECKED_SUBSCRIBE_FAILED =
  " Submission succeeded; notification signup failed (try again from the repo page).";

/**
 * Decision logic for what notification action to take after a successful repo submission.
 *
 * @param notifyOptIn - Whether the user checked the "Notify me" checkbox
 * @returns The action to take: "none" | "subscribe"
 */
export function decideNotificationAction(notifyOptIn: boolean): "none" | "subscribe" {
  return notifyOptIn ? "subscribe" : "none";
}

/**
 * Build the success message for the submit form based on the opt-in state
 * and subscription result.
 *
 * @param baseMessage - The base success message from the API (e.g., "Submitted — ingestion has been triggered...")
 * @param notifyOptIn - Whether the user checked the checkbox
 * @param subscribeResult - Result of the subscription attempt: "success" | "failed" | "unauthorized"
 * @returns The composed message to display
 */
export function buildSubmitSuccessMessage(
  baseMessage: string,
  notifyOptIn: boolean,
  subscribeResult: "success" | "failed" | "unauthorized",
): string {
  if (!notifyOptIn) {
    return baseMessage + SUCCESS_MESSAGE_UNCHECKED_SUFFIX;
  }

  switch (subscribeResult) {
    case "success":
      return baseMessage + SUCCESS_MESSAGE_CHECKED_SUBSCRIBED;
    case "failed":
    case "unauthorized":
      return baseMessage + SUCCESS_MESSAGE_CHECKED_SUBSCRIBE_FAILED;
  }
}
