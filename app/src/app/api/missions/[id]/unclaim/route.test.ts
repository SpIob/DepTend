/**
 * Route-level tests for POST /api/missions/[id]/unclaim — same shape as the
 * claim route's suite: real auth/rate-limit/validation boundaries, core's
 * unclaimMission() mocked at the module boundary (its own suite lives in
 * packages/core).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkMissionActionLimit } from "@/lib/rate-limit";
import { createRouteTestHarness, DB, VALID_ID } from "@/lib/test-helpers/route-test-setup";
import { POST } from "./route";

// ---- Top-level mocks (required by vitest) ----
const getServerSession = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

const getDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ getDb }));

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag }));

const unclaimMission = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/missions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  unclaimMission,
}));

// ---- Test harness ----
const { signedIn, post, mocks, runSharedTests, runSuccessTest, runFailureNoRevalidateTest } =
  createRouteTestHarness({
    handler: POST,
    rateLimiter: checkMissionActionLimit,
    baseUrl: "http://localhost/api/missions",
    makeCoreCallArgs: (login, id) => [DB, id, login],
    coreFn: unclaimMission,
    revalidateTag,
    getServerSession,
    getDb,
  });

describe("POST /api/missions/[id]/unclaim", () => {
  beforeEach(mocks.beforeEach);
  runSharedTests();

  it("maps not_found to 404", async () => {
    signedIn();
    unclaimMission.mockResolvedValue("not_found");
    const response = await post(VALID_ID);
    expect(response.status).toBe(404);
  });

  it("maps not_claimed_by_you to 409", async () => {
    signedIn();
    unclaimMission.mockResolvedValue("not_claimed_by_you");
    const response = await post(VALID_ID);
    expect(response.status).toBe(409);
  });

  runSuccessTest({
    description: "maps unclaimed to 200 and forwards db, id, and login to core",
    outcome: "unclaimed",
    expectedStatus: 200,
    expectedMessage: "Unclaimed.",
    beforeCall: () => {
      unclaimMission.mockResolvedValue("unclaimed");
    },
  });

  runFailureNoRevalidateTest("not_claimed_by_you", "does not revalidate when the unclaim fails");
});
