/**
 * Organization read/write queries
 */

import { eq } from "drizzle-orm";
import {
  organizations,
  organizationMembers,
  type Organization,
  type NewOrganization,
  type OrganizationMember,
} from "./schema.js";
import type { ReadonlyDb } from "./queries.js";

/**
 * Get organization by GitHub login
 */
export async function getOrganizationByLogin(
  db: ReadonlyDb,
  githubLogin: string,
): Promise<Organization | null> {
  const rows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.githubLogin, githubLogin))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Get organization by ID
 */
export async function getOrganizationById(
  db: ReadonlyDb,
  id: string,
): Promise<Organization | null> {
  const rows = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Get all organizations a user is a member of
 */
export async function getUserOrganizations(
  db: ReadonlyDb,
  userLogin: string,
): Promise<Organization[]> {
  const rows = await db
    .select({ org: organizations })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.organizationId, organizations.id))
    .where(eq(organizationMembers.userLogin, userLogin));
  return rows.map((r) => r.org);
}

/**
 * Get organization with members
 */
export async function getOrganizationWithMembers(
  db: ReadonlyDb,
  orgId: string,
): Promise<{ org: Organization | null; members: OrganizationMember[] }> {
  const org = await getOrganizationById(db, orgId);
  if (!org) return { org: null, members: [] };

  const members = await db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, orgId));

  return { org, members };
}

/**
 * Upsert organization (create or update)
 */
export async function upsertOrganization(
  db: ReadonlyDb,
  input: NewOrganization,
): Promise<Organization> {
  const inserted = await db
    .insert(organizations)
    .values(input)
    .onConflictDoUpdate({
      target: organizations.githubLogin,
      set: {
        name: input.name,
        avatarUrl: input.avatarUrl,
        updatedAt: new Date(),
      },
    })
    .returning();

  const row = inserted[0];
  if (!row) throw new Error(`upsertOrganization: no row returned for ${input.githubLogin}`);
  return row;
}

/**
 * Update organization
 */
export async function updateOrganization(
  db: ReadonlyDb,
  id: string,
  input: Partial<NewOrganization>,
): Promise<Organization | null> {
  const rows = await db
    .update(organizations)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(organizations.id, id))
    .returning();
  return rows[0] ?? null;
}
