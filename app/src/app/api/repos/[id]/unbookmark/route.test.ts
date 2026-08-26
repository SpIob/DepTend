/**
 * Route-level tests for POST /api/repos/[id]/unbookmark. unbookmarkRepo()
 * collapses "never bookmarked" and "repo doesn't exist" into one outcome
 * (see bookmarks.ts) and the route ignores it entirely — both are a no-op
 * success from the client's side, so there is deliberately no 404 branch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { checkMissionActionLimit } from "@/lib/rate-limit";

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

const DB = { __readonlyDbSentinel: true } as const;
const VALID_ID = "123e4567-e89b-12d3-a456-426614174000";

function signedIn(login = `user-${crypto.randomUUID()}`): string {
  getServerSession.mockResolvedValue({ user: { login } });
  getDb.mockReturnValue(DB);
  return login;
}

function post(id: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/repos/x/unbookmark", {
      method: "POST",
      // Same-origin Origin+Host pair on every request — exercises the
      // route's origin gate's positive path; its negative path has its own
      // case below.
      headers: { origin: "http://localhost", host: "localhost" },
    }),
    {
      params: Promise.resolve({ id }),
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/repos/[id]/unbookmark", () => {
  it("returns 403 for a cross-origin POST before any other gate", async () => {
    signedIn();
    const response = await POST(
      new Request("http://localhost/api/repos/x/unbookmark", {
        method: "POST",
        headers: { origin: "https://evil.example", host: "localhost" },
      }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );
    expect(response.status).toBe(403);
    expect(unbookmarkRepo).not.toHaveBeenCalled();
  });

  it("returns 401 with no session", async () => {
    getServerSession.mockResolvedValue(null);
    const response = await post(VALID_ID);
    expect(response.status).toBe(401);
    expect(unbookmarkRepo).not.toHaveBeenCalled();
  });

  it("returns 429 once the shared mission-action budget is exhausted", async () => {
    const login = signedIn();
    for (let i = 0; i < 20; i++) {
      checkMissionActionLimit(login);
    }
    const response = await post(VALID_ID);
    expect(response.status).toBe(429);
    expect(unbookmarkRepo).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed repo id before touching the DB", async () => {
    signedIn();
    const response = await post("not-a-uuid");
    expect(response.status).toBe(400);
    expect(unbookmarkRepo).not.toHaveBeenCalled();
  });

  it("returns 200 regardless of outcome — including unknown repo / not bookmarked", async () => {
    const login = signedIn();

    unbookmarkRepo.mockResolvedValue("unbookmarked");
    const removed = await post(VALID_ID);
    expect(removed.status).toBe(200);

    unbookmarkRepo.mockResolvedValue("not_bookmarked");
    const noop = await post(VALID_ID);
    expect(noop.status).toBe(200);

    expect(unbookmarkRepo).toHaveBeenCalledWith(DB, VALID_ID, login);
    const data = (await removed.json()) as { message?: string; bookmarked?: boolean };
    expect(data.message).toBe("Unbookmarked.");
    expect(data.bookmarked).toBe(false);
  });
});
