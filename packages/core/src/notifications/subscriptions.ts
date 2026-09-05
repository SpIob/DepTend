/**
 * Notification subscription database operations
 */

import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { notificationSubscriptions, type NotificationSubscription } from "../db/schema.js";
import type { ReadonlyDb } from "../db/queries.js";

/**
 * Subscribe a user to notifications for a repo. If a subscription already
 * exists for the (user, repo) pair, the existing row's event_types is
 * updated to the new value — discriminated by `outcome` so the route can
 * map "first time" to 201 Created and "updated event types" to 200 OK
 * (matches the established bookmark/unbookmark pattern).
 *
 * The insert-vs-update branch is detected by selecting PostgreSQL's
 * system column `xmax` alongside the row. On an INSERT, `xmax` is 0; on
 * an UPDATE (the onConflictDoUpdate branch), `xmax` is the current txid.
 * This is the same trick the existing Drizzle ecosystem uses for upsert
 * discrimination, and it keeps the whole path to one round-trip —
 * matching the established `onConflictDoUpdate` write pattern in
 * bookmarks.ts and organizations.ts.
 */
export async function subscribeToRepo(
  db: ReadonlyDb,
  options: {
    userLogin: string;
    repoId: string;
    eventTypes?: string[];
  },
): Promise<{
  outcome: "subscribed" | "updated";
  subscription: NotificationSubscription;
}> {
  const { userLogin, repoId, eventTypes = ["new_mission", "claimed", "resolved"] } = options;

  const rows = await db
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
    .returning({
      ...getTableColumns(notificationSubscriptions),
      xmax: sql<number>`xmax`,
    });

  const entry = rows[0];
  if (!entry) throw new Error(`subscribeToRepo: no row returned`);

  const { xmax, ...row } = entry;
  const outcome: "subscribed" | "updated" = xmax === 0 ? "subscribed" : "updated";
  return { outcome, subscription: row };
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
