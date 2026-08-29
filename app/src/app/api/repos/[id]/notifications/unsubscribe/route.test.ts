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
import { POST } from "./route";
import { checkMissionActionLimit } from "@/lib/rate-limit";

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

const DB = { __readonlyDbSentinel: true } as const;
const VALID_ID = "123e4567-e89b-12d3-a456-426614174000";

function signedIn(login = `user-${crypto.randomUUID()}`): string {
  getServerSession.mockResolvedValue({ user: { login } });
  getDb.mockReturnValue(DB);
  return login;
}

function post(): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/repos/${VALID_ID}/notifications/unsubscribe`, {
      method: "POST",
      headers: { origin: "http://localhost", host: "localhost" },
    }),
    { params: Promise.resolve({ id: VALID_ID }) },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/repos/[id]/notifications/unsubscribe", () => {
  it("returns 403 for a cross-origin POST before any other gate", async () => {
    signedIn();
    const response = await POST(
      new Request(`http://localhost/api/repos/${VALID_ID}/notifications/unsubscribe`, {
        method: "POST",
        headers: { origin: "https://evil.example", host: "localhost" },
      }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );
    expect(response.status).toBe(403);
    expect(unsubscribeFromRepo).not.toHaveBeenCalled();
  });

  it("returns 401 with no session", async () => {
    getServerSession.mockResolvedValue(null);
    const response = await post();
    expect(response.status).toBe(401);
    expect(unsubscribeFromRepo).not.toHaveBeenCalled();
  });

  it("returns 429 once the shared mission-action budget is exhausted", async () => {
    const login = signedIn();
    for (let i = 0; i < 20; i++) {
      checkMissionActionLimit(login);
    }
    const response = await post();
    expect(response.status).toBe(429);
    expect(unsubscribeFromRepo).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed repo id before touching the DB", async () => {
    signedIn();
    const response = await POST(
      new Request("http://localhost/api/repos/not-a-uuid/notifications/unsubscribe", {
        method: "POST",
        headers: { origin: "http://localhost", host: "localhost" },
      }),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );
    expect(response.status).toBe(400);
    expect(unsubscribeFromRepo).not.toHaveBeenCalled();
  });

  it("returns 404 when core reports no subscription existed", async () => {
    const login = signedIn();
    unsubscribeFromRepo.mockResolvedValue(false);
    const response = await post();
    expect(response.status).toBe(404);
    expect(unsubscribeFromRepo).toHaveBeenCalledWith(DB, login, VALID_ID);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("returns 200 and revalidates the repos tag on a successful unsubscribe", async () => {
    const login = signedIn();
    unsubscribeFromRepo.mockResolvedValue(true);
    const response = await post();
    expect(response.status).toBe(200);
    expect(unsubscribeFromRepo).toHaveBeenCalledWith(DB, login, VALID_ID);
    expect(revalidateTag).toHaveBeenCalledWith("repos");
  });
});
