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
import { POST } from "./route";
import { checkMissionActionLimit } from "@/lib/rate-limit";

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

const DB = { __readonlyDbSentinel: true } as const;
const VALID_ID = "223e4567-e89b-12d3-a456-426614174000";

function signedIn(login = `user-${crypto.randomUUID()}`): string {
  getServerSession.mockResolvedValue({ user: { login } });
  getDb.mockReturnValue(DB);
  return login;
}

function post(id: string, body?: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/missions/x/dismiss", {
      method: "POST",
      ...(body !== undefined
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/missions/[id]/dismiss", () => {
  it("returns 401 with no session", async () => {
    getServerSession.mockResolvedValue(null);
    const response = await post(VALID_ID);
    expect(response.status).toBe(401);
    expect(dismissMission).not.toHaveBeenCalled();
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
    expect(dismissMission).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed mission id before touching the DB", async () => {
    signedIn();
    const response = await post("not-a-uuid");
    expect(response.status).toBe(400);
    expect(dismissMission).not.toHaveBeenCalled();
  });

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
    expect(dismissMission).toHaveBeenNthCalledWith(1, DB, VALID_ID, "upstream won't fix");

    dismissMission.mockClear();
    dismissMission.mockResolvedValue("dismissed");
    await POST(
      new Request("http://localhost/api/missions/x/dismiss", {
        method: "POST",
        body: "not json at all",
      }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );
    expect(dismissMission).toHaveBeenCalledWith(DB, VALID_ID, null);
  });

  it("does not revalidate when the dismissal fails", async () => {
    signedIn();
    dismissMission.mockResolvedValue("not_open");
    await post(VALID_ID);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
