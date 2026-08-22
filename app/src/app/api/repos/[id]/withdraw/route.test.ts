/**
 * Route-level tests for POST /api/repos/[id]/withdraw (ADR 0030) — every
 * branch of withdrawOwnRepo()'s six-outcome union maps to a distinct
 * status code, and the route is the only place that mapping exists.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { checkMissionActionLimit } from "@/lib/rate-limit";

const getServerSession = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

const getDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ getDb }));

const withdrawOwnRepo = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/repos.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withdrawOwnRepo,
}));

const DB = { __readonlyDbSentinel: true } as const;
const VALID_ID = "123e4567-e89b-12d3-a456-426614174000";

function signedIn(login = `user-${crypto.randomUUID()}`): string {
  getServerSession.mockResolvedValue({ user: { login } });
  getDb.mockReturnValue(DB);
  return login;
}

function post(id: string): Promise<Response> {
  return POST(new Request("http://localhost/api/repos/x/withdraw", { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/repos/[id]/withdraw", () => {
  it("returns 401 with no session", async () => {
    getServerSession.mockResolvedValue(null);
    const response = await post(VALID_ID);
    expect(response.status).toBe(401);
    expect(withdrawOwnRepo).not.toHaveBeenCalled();
  });

  it("returns 429 once the shared mission-action budget is exhausted", async () => {
    const login = signedIn();
    for (let i = 0; i < 20; i++) {
      checkMissionActionLimit(login);
    }
    const response = await post(VALID_ID);
    expect(response.status).toBe(429);
    expect(withdrawOwnRepo).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed repo id before touching the DB", async () => {
    signedIn();
    const response = await post("not-a-uuid");
    expect(response.status).toBe(400);
    expect(withdrawOwnRepo).not.toHaveBeenCalled();
  });

  it("maps withdrawn to 200 and forwards db, id, and login to core", async () => {
    const login = signedIn();
    withdrawOwnRepo.mockResolvedValue("withdrawn");
    const response = await post(VALID_ID);
    expect(response.status).toBe(200);
    expect(withdrawOwnRepo).toHaveBeenCalledWith(DB, VALID_ID, login);
  });

  it("maps not_found to 404 and not_your_submission to 403", async () => {
    signedIn();

    withdrawOwnRepo.mockResolvedValue("not_found");
    expect((await post(VALID_ID)).status).toBe(404);

    withdrawOwnRepo.mockResolvedValue("not_your_submission");
    expect((await post(VALID_ID)).status).toBe(403);
  });

  it("maps all three guarded states to 409", async () => {
    signedIn();

    withdrawOwnRepo.mockResolvedValue("ingestion_in_progress");
    expect((await post(VALID_ID)).status).toBe(409);

    withdrawOwnRepo.mockResolvedValue("ingestion_failed_will_retry");
    expect((await post(VALID_ID)).status).toBe(409);

    withdrawOwnRepo.mockResolvedValue("already_indexed");
    expect((await post(VALID_ID)).status).toBe(409);
  });
});
