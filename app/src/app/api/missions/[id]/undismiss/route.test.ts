/**
 * Route-level tests for POST /api/missions/[id]/undismiss — the inverse of
 * dismiss. Same discipline: auth gate, shared rate-limit pool, id
 * validation, exhaustive outcome→status mapping around core's
 * undismissMission(), real (unmocked) rate limiter for the 429 case.
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

const undismissMission = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/missions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  undismissMission,
}));

// ---- Test harness ----
const { signedIn, post, mocks, runSharedTests, runSuccessTest, runFailureNoRevalidateTest } =
  createRouteTestHarness({
    handler: POST,
    rateLimiter: checkMissionActionLimit,
    baseUrl: "http://localhost/api/missions",
    makeCoreCallArgs: (_login, id) => [DB, id],
    coreFn: undismissMission,
    revalidateTag,
    getServerSession,
    getDb,
  });

describe("POST /api/missions/[id]/undismiss", () => {
  beforeEach(mocks.beforeEach);
  runSharedTests();

  it("maps not_found to 404", async () => {
    signedIn();
    undismissMission.mockResolvedValue("not_found");
    const response = await post(VALID_ID);
    expect(response.status).toBe(404);
  });

  it("maps not_dismissed to 409", async () => {
    signedIn();
    undismissMission.mockResolvedValue("not_dismissed");
    const response = await post(VALID_ID);
    expect(response.status).toBe(409);
  });

  runSuccessTest({
    description: "restores a dismissed mission to open and revalidates both tags",
    outcome: "restored",
    expectedStatus: 200,
    expectedMessage: "Restored to open.",
    beforeCall: () => {
      undismissMission.mockResolvedValue("restored");
    },
  });

  runFailureNoRevalidateTest("not_dismissed", "does not revalidate when the restore fails");
});
