/**
 * Route-level tests for POST /api/repos/[id]/notifications/unsubscribe.
 *
 * Pre-PR (2026-08-29) this route had no colocated test file - the seven
 * other mutating routes all did, and this one was the only gap. The PR
 * that adds the M3 (security audit) eventTypes allow-list to the
 * sibling subscribe route also fills that gap here.
 *
 * The unsubscribe path has no body to validate, so the only "body"
 * cases are the no-body POST. Origin gate, 401, 429, 400 (bad UUID),
 * 404 (no subscription), and 200 (success) are the only branches.
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

const unsubscribeFromRepo = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/notifications/subscriptions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  unsubscribeFromRepo,
}));

// ---- Test harness ----
const { signedIn, post, mocks, runSharedTests, runSuccessTest } = createRouteTestHarness({
  handler: POST,
  rateLimiter: checkMissionActionLimit,
  baseUrl: "http://localhost/api/repos",
  buildRequest: (id) => {
    return new Request(`http://localhost/api/repos/${id}/notifications/unsubscribe`, {
      method: "POST",
      headers: { origin: "http://localhost", host: "localhost" },
    });
  },
  makeCoreCallArgs: (login, id) => [DB, login, id],
  coreFn: unsubscribeFromRepo,
  revalidateTag,
  getServerSession,
  getDb,
});

describe("POST /api/repos/[id]/notifications/unsubscribe", () => {
  beforeEach(mocks.beforeEach);
  runSharedTests();

  it("returns 404 when core reports no subscription existed", async () => {
    const login = signedIn();
    unsubscribeFromRepo.mockResolvedValue(false);
    const response = await post(VALID_ID);
    expect(response.status).toBe(404);
    expect(unsubscribeFromRepo).toHaveBeenCalledWith(DB, login, VALID_ID);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  runSuccessTest({
    description: "returns 200 and revalidates the repos tag on a successful unsubscribe",
    outcome: "unsubscribed",
    expectedStatus: 200,
    expectedRevalidateTags: ["repos"],
    beforeCall: () => {
      unsubscribeFromRepo.mockResolvedValue(true);
    },
  });
});
