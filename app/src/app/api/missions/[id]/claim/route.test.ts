/**
 * Route-level tests for POST /api/missions/[id]/claim.
 *
 * The route's contract under test is its HTTP surface: auth gate, shared
 * rate-limit pool, id validation, and the exhaustive outcome→status mapping
 * around core's claimMission(). The DB write itself is mocked at the exact
 * boundary /app consumes (@deptend/core/db/missions.js) — claimMission()'s
 * real behavior has its own suite in packages/core. The rate limiter is NOT
 * mocked: the 429 case runs the real singleton against a unique login, same
 * discipline as rate-limit.test.ts.
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

const claimMission = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/missions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claimMission,
}));

const DB = { __readonlyDbSentinel: true } as const;
const VALID_ID = "123e4567-e89b-12d3-a456-426614174000";

function signedIn(login = `user-${crypto.randomUUID()}`): string {
  getServerSession.mockResolvedValue({ user: { login } });
  getDb.mockReturnValue(DB);
  return login;
}

function post(id: string): Promise<Response> {
  return POST(new Request("http://localhost/api/missions/x/claim", { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/missions/[id]/claim", () => {
  it("returns 401 with no session", async () => {
    getServerSession.mockResolvedValue(null);
    const response = await post(VALID_ID);
    expect(response.status).toBe(401);
    expect(claimMission).not.toHaveBeenCalled();
  });

  it("returns 429 once the shared mission-action budget is exhausted", async () => {
    const login = signedIn();
    for (let i = 0; i < 20; i++) {
      checkMissionActionLimit(login);
    }
    const response = await post(VALID_ID);
    expect(response.status).toBe(429);
    expect(Number.parseInt(response.headers.get("Retry-After") ?? "0", 10)).toBeGreaterThanOrEqual(
      1,
    );
    expect(claimMission).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed mission id before touching the DB", async () => {
    signedIn();
    const response = await post("not-a-uuid");
    expect(response.status).toBe(400);
    expect(claimMission).not.toHaveBeenCalled();
  });

  it("maps not_found to 404", async () => {
    signedIn();
    claimMission.mockResolvedValue("not_found");
    const response = await post(VALID_ID);
    expect(response.status).toBe(404);
  });

  it("maps already_claimed to 409", async () => {
    signedIn();
    claimMission.mockResolvedValue("already_claimed");
    const response = await post(VALID_ID);
    expect(response.status).toBe(409);
  });

  it("maps claimed to 200 and forwards db, id, and login to core", async () => {
    const login = signedIn();
    claimMission.mockResolvedValue("claimed");
    const response = await post(VALID_ID);
    expect(response.status).toBe(200);
    expect(claimMission).toHaveBeenCalledWith(DB, VALID_ID, login);
    const data = (await response.json()) as { message?: string; status?: string };
    expect(data.message).toBe("Claimed.");
    expect(data.status).toBe("claimed");
    // Success invalidates both cached views (ADR 0033).
    expect(revalidateTag).toHaveBeenCalledWith("missions");
    expect(revalidateTag).toHaveBeenCalledWith("repos");
  });

  it("does not revalidate when the claim fails", async () => {
    signedIn();
    claimMission.mockResolvedValue("already_claimed");
    await post(VALID_ID);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
