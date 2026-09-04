/**
 * Route-level tests for POST /api/repos/[id]/notifications/subscribe.
 *
 * Pre-PR (2026-08-29) this route had no colocated test file - the seven
 * other mutating routes all did, and this one was the only gap. The PR
 * that adds the M3 (security audit) eventTypes allow-list also fills
 * that gap.
 *
 * M3 cases live alongside the ADR 0037 origin gate, 401, 429, and 400
 * repo-id cases. Same conventions as the other route tests: real
 * rate limiter (the 429 case exhausts it), real isValidUuid, mocked
 * core, same-origin Origin+Host pair on every "happy path" request,
 * explicit cross-origin case.
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

const subscribeToRepo = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/notifications/subscriptions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  subscribeToRepo,
}));

// ---- Test harness ----
const { signedIn, post, mocks, runSharedTests } = createRouteTestHarness({
  handler: POST,
  rateLimiter: checkMissionActionLimit,
  baseUrl: "http://localhost/api/repos",
  buildRequest: (id, body) => {
    const url = `http://localhost/api/repos/${id}/notifications/subscribe`;
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
  makeCoreCallArgs: (login, id) => [DB, { userLogin: login, repoId: id }],
  coreFn: subscribeToRepo,
  revalidateTag,
  getServerSession,
  getDb,
});

function makeSubscription(eventTypes: string[]): Record<string, unknown> {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    userLogin: "ignored",
    repoId: VALID_ID,
    eventTypes,
    githubIssueNumber: null,
    createdAt: new Date(0),
  };
}

describe("POST /api/repos/[id]/notifications/subscribe", () => {
  beforeEach(mocks.beforeEach);
  runSharedTests();

  // M3 eventTypes validation tests
  it("M3: returns 400 for a non-array eventTypes", async () => {
    signedIn();
    const response = await post(VALID_ID, { eventTypes: "new_mission" });
    expect(response.status).toBe(400);
    const data = (await response.json()) as { error?: string };
    expect(data.error).toContain("eventTypes");
    expect(subscribeToRepo).not.toHaveBeenCalled();
  });

  it("M3: returns 400 for an empty eventTypes array", async () => {
    signedIn();
    const response = await post(VALID_ID, { eventTypes: [] });
    expect(response.status).toBe(400);
    expect(subscribeToRepo).not.toHaveBeenCalled();
  });

  it("M3: returns 400 for an eventTypes array over the 4-item cap", async () => {
    signedIn();
    const response = await post(VALID_ID, {
      eventTypes: ["new_mission", "claimed", "resolved", "reopened", "extra"],
    });
    expect(response.status).toBe(400);
    expect(subscribeToRepo).not.toHaveBeenCalled();
  });

  it("M3: returns 400 for an eventTypes entry that isn't in the allow-list", async () => {
    signedIn();
    const response = await post(VALID_ID, { eventTypes: ["new_mission", "xss-payload"] });
    expect(response.status).toBe(400);
    const data = (await response.json()) as { error?: string };
    expect(data.error).toContain("drawn from");
    expect(subscribeToRepo).not.toHaveBeenCalled();
  });

  it("M3: returns 400 for an eventTypes array with non-string entries", async () => {
    signedIn();
    const response = await post(VALID_ID, { eventTypes: ["new_mission", 42] });
    expect(response.status).toBe(400);
    expect(subscribeToRepo).not.toHaveBeenCalled();
  });

  it("accepts a missing body and falls through to the column default (no eventTypes passed to core)", async () => {
    const login = signedIn();
    subscribeToRepo.mockResolvedValue({
      outcome: "subscribed",
      subscription: makeSubscription(["new_mission", "claimed", "resolved"]),
    });
    const response = await post(VALID_ID);
    expect(response.status).toBe(201);
    expect(subscribeToRepo).toHaveBeenCalledWith(DB, {
      userLogin: login,
      repoId: VALID_ID,
    });
    expect(revalidateTag).toHaveBeenCalledWith("repos");
  });

  it("forwards a valid eventTypes array to core and revalidates the repos tag", async () => {
    const login = signedIn();
    subscribeToRepo.mockResolvedValue({
      outcome: "subscribed",
      subscription: makeSubscription(["new_mission", "resolved"]),
    });
    const response = await post(VALID_ID, { eventTypes: ["new_mission", "resolved"] });
    expect(response.status).toBe(201);
    expect(subscribeToRepo).toHaveBeenCalledWith(DB, {
      userLogin: login,
      repoId: VALID_ID,
      eventTypes: ["new_mission", "resolved"],
    });
    expect(revalidateTag).toHaveBeenCalledWith("repos");
  });

  it("returns 200 + 'Subscription updated.' when core reports the eventTypes update branch", async () => {
    signedIn();
    subscribeToRepo.mockResolvedValue({
      outcome: "updated",
      subscription: makeSubscription(["new_mission", "resolved"]),
    });
    const response = await post(VALID_ID, { eventTypes: ["new_mission", "resolved"] });
    expect(response.status).toBe(200);
    const data = (await response.json()) as { message: string };
    expect(data.message).toBe("Subscription updated.");
    expect(revalidateTag).toHaveBeenCalledWith("repos");
  });

  it("returns 500 and logs only the message (not the full Error object) when core throws", async () => {
    signedIn();
    // L2 contract: the route extracts err.message before logging so
    // Drizzle's bound-parameter error bodies - which sometimes echo
    // user-controlled values - never reach Vercel function logs. The
    // error.message itself is by design still developer-visible; this
    // test verifies the Error OBJECT isn't passed (the part that
    // would otherwise include stack + non-enumerable internals).
    const fullError = new Error("db connection lost");
    fullError.stack = "Error: db connection lost\n    at <internal>:1:1\n    [hidden]";
    Object.defineProperty(fullError, "cause", { value: "user-supplied-pii=abc123" });
    subscribeToRepo.mockRejectedValue(fullError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await post(VALID_ID, { eventTypes: ["new_mission"] });
    expect(response.status).toBe(500);
    const data = (await response.json()) as { error?: string };
    expect(data.error).toBe("Failed to subscribe to notifications.");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const firstCallArgs = errorSpy.mock.calls[0] ?? [];
    // The label and the message are passed; the Error object itself
    // is not. The label survives, the message survives (it was the
    // developer's intent for it to be visible), and no second/third
    // argument of the Error-object kind is present.
    const joined = firstCallArgs.map((arg) => String(arg)).join(" ");
    expect(joined).toContain("db connection lost");
    // .cause is on the Error object, not the message string - the
    // hardened log call must drop it.
    expect(joined).not.toContain("user-supplied-pii=abc123");
    errorSpy.mockRestore();
  });
});
