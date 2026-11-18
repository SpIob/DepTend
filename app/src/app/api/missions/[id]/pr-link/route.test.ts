/**
 * Route-level tests for POST /api/missions/[id]/pr-link.
 *
 * Same harness contract as the claim/unclaim/dismiss suites: auth gate,
 * shared rate-limit pool, id validation, and the exhaustive outcome→status
 * mapping around core's setMissionPrUrl(). The DB write is mocked at the
 * exact module boundary /app consumes; parsePullRequestUrl stays REAL via
 * importOriginal (validators are part of this route's contract, and the
 * 400-on-bad-URL cases exercise it directly). The rate limiter is NOT
 * mocked — the 429 case runs the real singleton.
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

const setMissionPrUrl = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/missions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setMissionPrUrl,
}));

const VALID_PR_URL = "https://github.com/owner/repo/pull/42";

// ---- Test harness ----
// Every POST carries a JSON body; the default is a valid PR URL so the
// shared gate tests and the primary success path can reuse the harness.
const { signedIn, post, mocks, runSharedTests, runSuccessTest, runFailureNoRevalidateTest } =
  createRouteTestHarness({
    handler: POST,
    rateLimiter: checkMissionActionLimit,
    baseUrl: "http://localhost/api/missions",
    buildRequest: (id, body) => {
      const effective = body === undefined ? { prUrl: VALID_PR_URL } : body;
      return new Request(`http://localhost/api/missions/${id}`, {
        method: "POST",
        headers: {
          origin: "http://localhost",
          host: "localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify(effective),
      });
    },
    makeCoreCallArgs: (login, id) => [DB, id, VALID_PR_URL, login],
    coreFn: setMissionPrUrl,
    successRevalidateTags: ["missions"],
    revalidateTag,
    getServerSession,
    getDb,
  });

describe("POST /api/missions/[id]/pr-link", () => {
  beforeEach(mocks.beforeEach);
  runSharedTests();

  it("rejects a body that is not {prUrl: string | null} with 400", async () => {
    signedIn();
    const response = await post(VALID_ID, { prUrl: 17 });
    expect(response.status).toBe(400);
    expect(setMissionPrUrl).not.toHaveBeenCalled();
  });

  it("rejects a non-GitHub-PR URL with 400 and never reaches core", async () => {
    signedIn();
    const response = await post(VALID_ID, { prUrl: "https://github.com/owner/repo/issues/42" });
    expect(response.status).toBe(400);
    expect(setMissionPrUrl).not.toHaveBeenCalled();
  });

  it("normalizes a trailing-slash PR URL before calling core", async () => {
    signedIn();
    setMissionPrUrl.mockResolvedValue("updated");
    const response = await post(VALID_ID, { prUrl: "https://github.com/owner/repo/pull/42/" });
    expect(response.status).toBe(200);
    expect(setMissionPrUrl).toHaveBeenCalledWith(DB, VALID_ID, VALID_PR_URL, expect.any(String));
    void response;
  });

  it("maps prUrl null to a cleared link and a distinct success message", async () => {
    const login = signedIn();
    setMissionPrUrl.mockResolvedValue("updated");
    const response = await post(VALID_ID, { prUrl: null });
    expect(response.status).toBe(200);
    expect(setMissionPrUrl).toHaveBeenCalledWith(DB, VALID_ID, null, login);
    const data = (await response.json()) as { message?: string };
    expect(data.message).toBe("PR link removed.");
    expect(revalidateTag).toHaveBeenCalledWith("missions");
  });

  it("maps not_found to 404", async () => {
    signedIn();
    setMissionPrUrl.mockResolvedValue("not_found");
    const response = await post(VALID_ID);
    expect(response.status).toBe(404);
  });

  it("maps not_claimed_by_you to 409", async () => {
    signedIn();
    setMissionPrUrl.mockResolvedValue("not_claimed_by_you");
    const response = await post(VALID_ID);
    expect(response.status).toBe(409);
  });

  runSuccessTest({
    description: "maps updated to 200, forwards db/id/url/login, and revalidates missions only",
    outcome: "updated",
    expectedStatus: 200,
    expectedMessage: "PR link saved.",
    expectedRevalidateTags: ["missions"],
    beforeCall: () => {
      setMissionPrUrl.mockResolvedValue("updated");
    },
  });

  runFailureNoRevalidateTest("not_claimed_by_you", "does not revalidate when the write fails");
});
