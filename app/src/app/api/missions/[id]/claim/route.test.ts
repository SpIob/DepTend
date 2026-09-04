/**
 * Route-level tests for POST /api/missions/[id]/claim.
 *
 * The route's contract under test is its HTTP surface: auth gate, shared
 * rate-limit pool, id validation, and the exhaustive outcome→status mapping
 * around core's claimMission(). The DB write itself is mocked at the exact
 * boundary /app consumes (@deptend/core/db/missions.js) — claimMission()'s
 * real behavior has its own suite in packages/core. The rate limiter is NOT
 * mocked: the 429 case runs the real singleton against a unique login, same
 * discipline as rate-limit.test.ts.
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

const claimMission = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/missions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claimMission,
}));

// ---- Test harness ----
const { signedIn, post, mocks, runSharedTests, runSuccessTest, runFailureNoRevalidateTest } =
  createRouteTestHarness({
    handler: POST,
    rateLimiter: checkMissionActionLimit,
    baseUrl: "http://localhost/api/missions",
    makeCoreCallArgs: (login, id) => [DB, id, login],
    coreFn: claimMission,
    revalidateTag,
    getServerSession,
    getDb,
  });

describe("POST /api/missions/[id]/claim", () => {
  beforeEach(mocks.beforeEach);
  runSharedTests();

  it("maps not_found to 404", async () => {
    signedIn();
    claimMission.mockResolvedValue("not_found");
    const response = await post(VALID_ID);
    expect(response.status).toBe(404);
  });

  it("maps already_claimed to 409", async () => {
    signedIn();
    claimMission.mockResolvedValue("already_claimed");
    const response = await post(VALID_ID);
    expect(response.status).toBe(409);
  });

  runSuccessTest({
    description: "maps claimed to 200 and forwards db, id, and login to core",
    outcome: "claimed",
    expectedStatus: 200,
    expectedMessage: "Claimed.",
    beforeCall: () => {
      claimMission.mockResolvedValue("claimed");
    },
  });

  runFailureNoRevalidateTest("already_claimed", "does not revalidate when the claim fails");
});
