/**
 * Notification subscription database operations
 */

import { and, eq, sql } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { notificationSubscriptions, type NotificationSubscription } from "../db/schema.js";
import * as schema from "../db/schema.js";

export type ReadonlyDb = NeonHttpDatabase<typeof schema>;

export interface SubscriptionOptions {
  userLogin: string;
  repoId: string;
  eventTypes?: string[];
}

/**
 * Subscribe a user to notifications for a repo
 */
export async function subscribeToRepo(
  db: ReadonlyDb,
  options: SubscriptionOptions,
): Promise<NotificationSubscription> {
  const { userLogin, repoId, eventTypes = ["new_mission", "claimed", "resolved"] } = options;

  const inserted = await db
    .insert(notificationSubscriptions)
    .values({
      userLogin,
      repoId,
      eventTypes,
    })
    .onConflictDoUpdate({
      target: [notificationSubscriptions.userLogin, notificationSubscriptions.repoId],
      set: {
        eventTypes: sql`excluded.event_types`,
      },
    })
    .returning();

  const row = inserted[0];
  if (!row) throw new Error(`subscribeToRepo: no row returned`);
  return row;
}

/**
 * Unsubscribe a user from notifications for a repo
 */
export async function unsubscribeFromRepo(
  db: ReadonlyDb,
  userLogin: string,
  repoId: string,
): Promise<boolean> {
  const result = await db
    .delete(notificationSubscriptions)
    .where(
      and(
        eq(notificationSubscriptions.userLogin, userLogin),
        eq(notificationSubscriptions.repoId, repoId),
      ),
    );
  return result.rowCount > 0;
}

/**
 * Get a user's subscription for a specific repo
 */
export async function getSubscription(
  db: ReadonlyDb,
  userLogin: string,
  repoId: string,
): Promise<NotificationSubscription | null> {
  const rows = await db
    .select()
    .from(notificationSubscriptions)
    .where(
      and(
        eq(notificationSubscriptions.userLogin, userLogin),
        eq(notificationSubscriptions.repoId, repoId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Get all subscriptions for a user
 */
export async function getUserSubscriptions(
  db: ReadonlyDb,
  userLogin: string,
): Promise<NotificationSubscription[]> {
  return db
    .select()
    .from(notificationSubscriptions)
    .where(eq(notificationSubscriptions.userLogin, userLogin));
}

/**
 * Get all subscriptions for a repo
 */
export async function getRepoSubscriptions(
  db: ReadonlyDb,
  repoId: string,
): Promise<NotificationSubscription[]> {
  return db
    .select()
    .from(notificationSubscriptions)
    .where(eq(notificationSubscriptions.repoId, repoId));
}

/**
 * Update the GitHub issue number for a subscription
 */
export async function updateSubscriptionIssueNumber(
  db: ReadonlyDb,
  userLogin: string,
  repoId: string,
  issueNumber: number,
): Promise<void> {
  await db
    .update(notificationSubscriptions)
    .set({ githubIssueNumber: issueNumber })
    .where(
      and(
        eq(notificationSubscriptions.userLogin, userLogin),
        eq(notificationSubscriptions.repoId, repoId),
      ),
    );
}
