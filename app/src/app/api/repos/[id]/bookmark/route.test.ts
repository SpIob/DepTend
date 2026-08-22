/**
 * Route-level tests for POST /api/repos/[id]/bookmark. bookmarkRepo()'s
 * "already_bookmarked" outcome deliberately shares the success branch —
 * bookmarking twice is idempotent from the client's perspective.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { checkMissionActionLimit } from "@/lib/rate-limit";

const getServerSession = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

const getDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ getDb }));

const bookmarkRepo = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/bookmarks.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  bookmarkRepo,
}));

const DB = { __readonlyDbSentinel: true } as const;
const VALID_ID = "123e4567-e89b-12d3-a456-426614174000";

function signedIn(login = `user-${crypto.randomUUID()}`): string {
  getServerSession.mockResolvedValue({ user: { login } });
  getDb.mockReturnValue(DB);
  return login;
}

function post(id: string): Promise<Response> {
  return POST(new Request("http://localhost/api/repos/x/bookmark", { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/repos/[id]/bookmark", () => {
  it("returns 401 with no session", async () => {
    getServerSession.mockResolvedValue(null);
    const response = await post(VALID_ID);
    expect(response.status).toBe(401);
    expect(bookmarkRepo).not.toHaveBeenCalled();
  });

  it("returns 429 once the shared mission-action budget is exhausted", async () => {
    const login = signedIn();
    for (let i = 0; i < 20; i++) {
      checkMissionActionLimit(login);
    }
    const response = await post(VALID_ID);
    expect(response.status).toBe(429);
    expect(bookmarkRepo).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed repo id before touching the DB", async () => {
    signedIn();
    const response = await post("not-a-uuid");
    expect(response.status).toBe(400);
    expect(bookmarkRepo).not.toHaveBeenCalled();
  });

  it("maps not_found to 404", async () => {
    const login = signedIn();
    bookmarkRepo.mockResolvedValue("not_found");
    const response = await post(VALID_ID);
    expect(response.status).toBe(404);
    expect(bookmarkRepo).toHaveBeenCalledWith(DB, VALID_ID, login);
  });

  it("maps both bookmarked and already_bookmarked to 200", async () => {
    signedIn();
    bookmarkRepo.mockResolvedValue("bookmarked");
    const first = await post(VALID_ID);
    expect(first.status).toBe(200);

    bookmarkRepo.mockResolvedValue("already_bookmarked");
    const second = await post(VALID_ID);
    expect(second.status).toBe(200);

    const data = (await second.json()) as { message?: string; bookmarked?: boolean };
    expect(data.message).toBe("Bookmarked.");
    expect(data.bookmarked).toBe(true);
  });
});
