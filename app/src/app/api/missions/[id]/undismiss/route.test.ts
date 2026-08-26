/**
 * Route-level tests for POST /api/missions/[id]/undismiss — the inverse of
 * dismiss. Same discipline: auth gate, shared rate-limit pool, id
 * validation, exhaustive outcome→status mapping around core's
 * undismissMission(), real (unmocked) rate limiter for the 429 case.
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

const undismissMission = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/missions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  undismissMission,
}));

const DB = { __readonlyDbSentinel: true } as const;
const VALID_ID = "323e4567-e89b-12d3-a456-426614174000";

function signedIn(login = `user-${crypto.randomUUID()}`): string {
  getServerSession.mockResolvedValue({ user: { login } });
  getDb.mockReturnValue(DB);
  return login;
}

function post(id: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/missions/x/undismiss", {
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

describe("POST /api/missions/[id]/undismiss", () => {
  it("returns 403 for a cross-origin POST before any other gate", async () => {
    signedIn();
    const response = await POST(
      new Request("http://localhost/api/missions/x/undismiss", {
        method: "POST",
        headers: { origin: "https://evil.example", host: "localhost" },
      }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );
    expect(response.status).toBe(403);
    expect(undismissMission).not.toHaveBeenCalled();
  });

  it("returns 401 with no session", async () => {
    getServerSession.mockResolvedValue(null);
    const response = await post(VALID_ID);
    expect(response.status).toBe(401);
    expect(undismissMission).not.toHaveBeenCalled();
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
    expect(undismissMission).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed mission id before touching the DB", async () => {
    signedIn();
    const response = await post("not-a-uuid");
    expect(response.status).toBe(400);
    expect(undismissMission).not.toHaveBeenCalled();
  });

  it("maps not_found to 404", async () => {
    signedIn();
    undismissMission.mockResolvedValue("not_found");
    const response = await post(VALID_ID);
    expect(response.status).toBe(404);
  });

  it("maps not_dismissed to 409", async () => {
    signedIn();
    undismissMission.mockResolvedValue("not_dismissed");
    const response = await post(VALID_ID);
    expect(response.status).toBe(409);
  });

  it("restores a dismissed mission to open and revalidates both tags", async () => {
    signedIn();
    undismissMission.mockResolvedValue("restored");
    const response = await post(VALID_ID);
    expect(response.status).toBe(200);
    expect(undismissMission).toHaveBeenCalledWith(DB, VALID_ID);
    expect(revalidateTag).toHaveBeenCalledWith("missions");
    expect(revalidateTag).toHaveBeenCalledWith("repos");
    const data = (await response.json()) as { message?: string; status?: string };
    expect(data.message).toBe("Restored to open.");
    expect(data.status).toBe("open");
  });

  it("does not revalidate when the restore fails", async () => {
    signedIn();
    undismissMission.mockResolvedValue("not_dismissed");
    await post(VALID_ID);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
