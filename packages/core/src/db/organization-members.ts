/**
 * Organization member read/write queries
 */

import { and, eq } from "drizzle-orm";
import {
  organizationMembers,
  type OrganizationMember,
  type NewOrganizationMember,
} from "./schema.js";
import type { ReadonlyDb } from "./queries.js";

/**
 * Get membership by org and user
 */
export async function getMembership(
  db: ReadonlyDb,
  organizationId: string,
  userLogin: string,
): Promise<OrganizationMember | null> {
  const rows = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userLogin, userLogin),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Add a member to an organization
 */
export async function addMember(
  db: ReadonlyDb,
  input: NewOrganizationMember,
): Promise<OrganizationMember> {
  const inserted = await db
    .insert(organizationMembers)
    .values(input)
    .onConflictDoUpdate({
      target: [organizationMembers.organizationId, organizationMembers.userLogin],
      set: {
        role: input.role,
      },
    })
    .returning();

  const row = inserted[0];
  if (!row) throw new Error(`addMember: no row returned`);
  return row;
}

/**
 * Update member role
 */
export async function updateMemberRole(
  db: ReadonlyDb,
  organizationId: string,
  userLogin: string,
  role: string,
): Promise<OrganizationMember | null> {
  const rows = await db
    .update(organizationMembers)
    .set({ role })
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userLogin, userLogin),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Remove member from organization
 */
export async function removeMember(
  db: ReadonlyDb,
  organizationId: string,
  userLogin: string,
): Promise<boolean> {
  const result = await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userLogin, userLogin),
      ),
    );
  return result.rowCount > 0;
}

/**
 * List members of an organization
 */
export async function listMembers(
  db: ReadonlyDb,
  organizationId: string,
): Promise<OrganizationMember[]> {
  return db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, organizationId));
}
