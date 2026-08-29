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
import { POST } from "./route";
import { checkMissionActionLimit } from "@/lib/rate-limit";

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

const isValidUuid = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/validation.js", async (importOriginal) => {
  // Keep the real isValidUuid for the route's own UUID check; the route
  // also reaches it indirectly through the API path, and mocking it
  // would defeat the test's "real validator" convention.
  const actual = await importOriginal<typeof import("@deptend/core/db/validation.js")>();
  return { ...actual, isValidUuid };
});

const DB = { __readonlyDbSentinel: true } as const;
const VALID_ID = "123e4567-e89b-12d3-a456-426614174000";

function signedIn(login = `user-${crypto.randomUUID()}`): string {
  getServerSession.mockResolvedValue({ user: { login } });
  getDb.mockReturnValue(DB);
  // Wire the real isValidUuid through; the test fixture controls
  // behavior by what it sends, not by mocking the validator.
  isValidUuid.mockImplementation((value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  );
  return login;
}

function postJson(body: unknown): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/repos/${VALID_ID}/notifications/subscribe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        host: "localhost",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: VALID_ID }) },
  );
}

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

beforeEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/repos/[id]/notifications/subscribe", () => {
  it("returns 403 for a cross-origin POST before any other gate", async () => {
    signedIn();
    const response = await POST(
      new Request(`http://localhost/api/repos/${VALID_ID}/notifications/subscribe`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          host: "localhost",
        },
        body: JSON.stringify({ eventTypes: ["new_mission"] }),
      }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );
    expect(response.status).toBe(403);
    expect(subscribeToRepo).not.toHaveBeenCalled();
  });

  it("returns 401 with no session", async () => {
    getServerSession.mockResolvedValue(null);
    const response = await postJson({ eventTypes: ["new_mission"] });
    expect(response.status).toBe(401);
    expect(subscribeToRepo).not.toHaveBeenCalled();
  });

  it("returns 429 once the shared mission-action budget is exhausted", async () => {
    const login = signedIn();
    for (let i = 0; i < 20; i++) {
      checkMissionActionLimit(login);
    }
    const response = await postJson({ eventTypes: ["new_mission"] });
    expect(response.status).toBe(429);
    expect(subscribeToRepo).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed repo id before touching the DB", async () => {
    signedIn();
    const response = await POST(
      new Request("http://localhost/api/repos/not-a-uuid/notifications/subscribe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
          host: "localhost",
        },
        body: JSON.stringify({ eventTypes: ["new_mission"] }),
      }),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );
    expect(response.status).toBe(400);
    expect(subscribeToRepo).not.toHaveBeenCalled();
  });

  it("M3: returns 400 for a non-array eventTypes", async () => {
    signedIn();
    const response = await postJson({ eventTypes: "new_mission" });
    expect(response.status).toBe(400);
    const data = (await response.json()) as { error?: string };
    expect(data.error).toContain("eventTypes");
    expect(subscribeToRepo).not.toHaveBeenCalled();
  });

  it("M3: returns 400 for an empty eventTypes array", async () => {
    signedIn();
    const response = await postJson({ eventTypes: [] });
    expect(response.status).toBe(400);
    expect(subscribeToRepo).not.toHaveBeenCalled();
  });

  it("M3: returns 400 for an eventTypes array over the 4-item cap", async () => {
    signedIn();
    const response = await postJson({
      eventTypes: ["new_mission", "claimed", "resolved", "reopened", "extra"],
    });
    expect(response.status).toBe(400);
    expect(subscribeToRepo).not.toHaveBeenCalled();
  });

  it("M3: returns 400 for an eventTypes entry that isn't in the allow-list", async () => {
    signedIn();
    const response = await postJson({ eventTypes: ["new_mission", "xss-payload"] });
    expect(response.status).toBe(400);
    const data = (await response.json()) as { error?: string };
    expect(data.error).toContain("drawn from");
    expect(subscribeToRepo).not.toHaveBeenCalled();
  });

  it("M3: returns 400 for an eventTypes array with non-string entries", async () => {
    signedIn();
    const response = await postJson({ eventTypes: ["new_mission", 42] });
    expect(response.status).toBe(400);
    expect(subscribeToRepo).not.toHaveBeenCalled();
  });

  it("accepts a missing body and falls through to the column default (no eventTypes passed to core)", async () => {
    const login = signedIn();
    subscribeToRepo.mockResolvedValue({
      outcome: "subscribed",
      subscription: makeSubscription(["new_mission", "claimed", "resolved"]),
    });
    const response = await postJson("");
    expect(response.status).toBe(201);
    expect(subscribeToRepo).toHaveBeenCalledWith(DB, {
      userLogin: login,
      repoId: VALID_ID,
    });
  });

  it("forwards a valid eventTypes array to core and revalidates the repos tag", async () => {
    const login = signedIn();
    subscribeToRepo.mockResolvedValue({
      outcome: "subscribed",
      subscription: makeSubscription(["new_mission", "resolved"]),
    });
    const response = await postJson({ eventTypes: ["new_mission", "resolved"] });
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
    const response = await postJson({ eventTypes: ["new_mission", "resolved"] });
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
    const response = await postJson({ eventTypes: ["new_mission"] });
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
