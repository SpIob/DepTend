/**
 * Route-level tests for POST /api/repos/[id]/unbookmark. unbookmarkRepo()
 * collapses "never bookmarked" and "repo doesn't exist" into one outcome
 * (see bookmarks.ts) and the route ignores it entirely — both are a no-op
 * success from the client's side, so there is deliberately no 404 branch.
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

const unbookmarkRepo = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/bookmarks.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  unbookmarkRepo,
}));

// ---- Test harness ----
const { signedIn, post, mocks, runSharedTests, runSuccessTest } = createRouteTestHarness({
  handler: POST,
  rateLimiter: checkMissionActionLimit,
  baseUrl: "http://localhost/api/repos",
  buildRequest: (id) => {
    return new Request(`http://localhost/api/repos/${id}/unbookmark`, {
      method: "POST",
      headers: { origin: "http://localhost", host: "localhost" },
    });
  },
  makeCoreCallArgs: (login, id) => [DB, id, login],
  coreFn: unbookmarkRepo,
  getServerSession,
  getDb,
  // unbookmarkRepo only takes (db, repoId, login) - no revalidateTag by design
  revalidateTag: undefined,
});

describe("POST /api/repos/[id]/unbookmark", () => {
  beforeEach(mocks.beforeEach);
  runSharedTests();

  // unbookmark has no 404 - it returns 200 for both unbookmarked and not_bookmarked
  runSuccessTest({
    description: "returns 200 regardless of outcome — including unknown repo / not bookmarked",
    outcome: "unbookmarked",
    expectedStatus: 200,
    expectedMessage: "Unbookmarked.",
    beforeCall: () => {
      unbookmarkRepo.mockResolvedValue("unbookmarked");
    },
    expectedRevalidateTags: [],
  });

  it("maps not_bookmarked to 200 as well", async () => {
    const login = signedIn();
    unbookmarkRepo.mockResolvedValue("not_bookmarked");
    const response = await post(VALID_ID);
    expect(response.status).toBe(200);
    expect(unbookmarkRepo).toHaveBeenCalledWith(DB, VALID_ID, login);
    const data = (await response.json()) as { message?: string; bookmarked?: boolean };
    expect(data.message).toBe("Unbookmarked.");
    expect(data.bookmarked).toBe(false);
  });
});
