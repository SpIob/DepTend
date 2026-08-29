/**
 * Organization queries for /app
 */

import {
  getOrganizationByLogin as coreGetOrganizationByLogin,
  getUserOrganizations as coreGetUserOrganizations,
} from "@deptend/core/db/organizations.js";
import { getRepoDirectoryBase as coreGetRepoDirectoryBase } from "@deptend/core/db/queries.js";
import type { Organization, RepoWithMissionSummary } from "@deptend/core";
import { getDb } from "../db";
import { cachedRead } from "./cached-read";

export async function getOrganizationByLogin(orgLogin: string): Promise<Organization | null> {
  return cachedRead(["org-by-login", orgLogin], "organizations", () =>
    coreGetOrganizationByLogin(getDb(), orgLogin),
  );
}

export async function getUserOrganizations(userLogin: string): Promise<Organization[]> {
  return cachedRead(["user-orgs", userLogin], "organizations", () =>
    coreGetUserOrganizations(getDb(), userLogin),
  );
}

/**
 * Org-scoped repo directory. Same per-user overlay as the board-wide read
 * (bookmarks + subscriptions) — the per-user path bypasses cache, the
 * anonymous path caches under "repos" (ADR 0033). Both are owned by
 * core's getRepoDirectoryBase now, so the overlay can never drift between
 * the two pages.
 */
export function getReposByOrg(
  orgLogin: string,
  userLogin?: string,
): Promise<RepoWithMissionSummary[]> {
  if (userLogin === undefined) {
    return cachedRead(["org-repos", orgLogin], "repos", () =>
      coreGetRepoDirectoryBase(getDb(), { orgLogin }),
    );
  }
  return coreGetRepoDirectoryBase(getDb(), { orgLogin, userLogin });
}
