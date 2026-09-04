/**
 * Route-level tests for POST /api/missions/[id]/dismiss.
 *
 * Same contract-under-test as the claim/unclaim suites: auth gate, shared
 * rate-limit pool, id validation, optional-reason body handling, and the
 * exhaustive outcome→status mapping around core's dismissMission(). The DB
 * write is mocked at the exact boundary /app consumes; the rate limiter is
 * NOT mocked — the 429 case runs the real singleton against a unique login.
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

const dismissMission = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/missions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dismissMission,
}));

// ---- Test harness ----
const { signedIn, post, mocks, runSharedTests, runFailureNoRevalidateTest } =
  createRouteTestHarness({
    handler: POST,
    rateLimiter: checkMissionActionLimit,
    baseUrl: "http://localhost/api/missions",
    buildRequest: (id, body) => {
      const url = `http://localhost/api/missions/${id}/dismiss`;
      const headers: Record<string, string> = {
        origin: "http://localhost",
        host: "localhost",
      };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
      }
      return new Request(url, {
        method: "POST",
        headers,
        ...(body !== undefined
          ? { body: typeof body === "string" ? body : JSON.stringify(body) }
          : {}),
      });
    },
    makeCoreCallArgs: (login, id) => [DB, id, login],
    coreFn: dismissMission,
    revalidateTag,
    getServerSession,
    getDb,
  });

describe("POST /api/missions/[id]/dismiss", () => {
  beforeEach(mocks.beforeEach);
  runSharedTests();

  it("rejects a non-string reason with 400 before touching the DB", async () => {
    signedIn();
    const response = await post(VALID_ID, { reason: 42 });
    expect(response.status).toBe(400);
    expect(dismissMission).not.toHaveBeenCalled();
  });

  it("maps not_found to 404", async () => {
    signedIn();
    dismissMission.mockResolvedValue("not_found");
    const response = await post(VALID_ID);
    expect(response.status).toBe(404);
  });

  it("maps not_open to 409", async () => {
    signedIn();
    dismissMission.mockResolvedValue("not_open");
    const response = await post(VALID_ID);
    expect(response.status).toBe(409);
  });

  it("dismisses without a body and forwards null reason", async () => {
    signedIn();
    dismissMission.mockResolvedValue("dismissed");
    const response = await post(VALID_ID);
    expect(response.status).toBe(200);
    expect(dismissMission).toHaveBeenCalledWith(DB, VALID_ID, null);
    expect(revalidateTag).toHaveBeenCalledWith("missions");
    expect(revalidateTag).toHaveBeenCalledWith("repos");
    const data = (await response.json()) as { status?: string };
    expect(data.status).toBe("dismissed");
  });

  it("passes a trimmed reason through and tolerates an unparseable body", async () => {
    signedIn();
    dismissMission.mockResolvedValue("dismissed");
    await post(VALID_ID, { reason: "  upstream won't fix  " });
    expect(dismissMission).toHaveBeenCalledWith(DB, VALID_ID, "upstream won't fix");

    dismissMission.mockClear();
    dismissMission.mockResolvedValue("dismissed");
    await post(VALID_ID, "not json at all");
    expect(dismissMission).toHaveBeenCalledWith(DB, VALID_ID, null);
  });

  runFailureNoRevalidateTest("not_open", "does not revalidate when the dismissal fails");
});
