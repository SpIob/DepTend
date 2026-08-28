/**
 * Organization queries for /app
 */

import { unstable_cache } from "next/cache";
import {
  getOrganizationByLogin as coreGetOrganizationByLogin,
  getUserOrganizations as coreGetUserOrganizations,
} from "@deptend/core/db/organizations.js";
import { getRepoDirectoryBaseByOrg as coreGetReposByOrg } from "@deptend/core/db/queries.js";
import type { Organization, RepoWithMissionSummary } from "@deptend/core";
import { getDb } from "../db";
import { reviveDates } from "./missions";

const READ_CACHE_SECONDS = 60;

function cachedRead<T>(
  keyParts: string[],
  tag: "missions" | "repos" | "organizations",
  read: () => Promise<T>,
): Promise<T> {
  const cached = unstable_cache(read, keyParts, {
    revalidate: READ_CACHE_SECONDS,
    tags: [tag],
  });
  return cached().then(reviveDates);
}

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

export async function getReposByOrg(orgLogin: string): Promise<RepoWithMissionSummary[]> {
  return cachedRead(["org-repos", orgLogin], "repos", () => coreGetReposByOrg(getDb(), orgLogin));
}
