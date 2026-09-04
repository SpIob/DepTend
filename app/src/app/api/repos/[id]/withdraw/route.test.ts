/**
 * Route-level tests for POST /api/repos/[id]/withdraw (ADR 0030) — every
 * branch of withdrawOwnRepo()'s six-outcome union maps to a distinct
 * status code, and the route is the only place that mapping exists.
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

const withdrawOwnRepo = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/repos.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withdrawOwnRepo,
}));

// ---- Test harness ----
const { signedIn, post, mocks, runSharedTests, runSuccessTest } = createRouteTestHarness({
  handler: POST,
  rateLimiter: checkMissionActionLimit,
  baseUrl: "http://localhost/api/repos",
  buildRequest: (id) => {
    return new Request(`http://localhost/api/repos/${id}/withdraw`, {
      method: "POST",
      headers: { origin: "http://localhost", host: "localhost" },
    });
  },
  makeCoreCallArgs: (login, id) => [DB, id, login],
  coreFn: withdrawOwnRepo,
  revalidateTag,
  getServerSession,
  getDb,
});

describe("POST /api/repos/[id]/withdraw", () => {
  beforeEach(mocks.beforeEach);
  runSharedTests();

  runSuccessTest({
    description: "maps withdrawn to 200 and forwards db, id, and login to core",
    outcome: "withdrawn",
    expectedStatus: 200,
    beforeCall: () => {
      withdrawOwnRepo.mockResolvedValue("withdrawn");
    },
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
