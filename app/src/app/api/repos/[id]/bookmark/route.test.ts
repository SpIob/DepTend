/**
 * Route-level tests for POST /api/repos/[id]/bookmark. bookmarkRepo()'s
 * "already_bookmarked" outcome deliberately shares the success branch —
 * bookmarking twice is idempotent from the client's perspective.
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

const bookmarkRepo = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/bookmarks.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  bookmarkRepo,
}));

// ---- Test harness ----
const { signedIn, post, mocks, runSharedTests } = createRouteTestHarness({
  handler: POST,
  rateLimiter: checkMissionActionLimit,
  baseUrl: "http://localhost/api/repos",
  buildRequest: (id) => {
    return new Request(`http://localhost/api/repos/${id}/bookmark`, {
      method: "POST",
      headers: { origin: "http://localhost", host: "localhost" },
    });
  },
  makeCoreCallArgs: (login, id) => [DB, id, login],
  coreFn: bookmarkRepo,
  getServerSession,
  getDb,
  // bookmarkRepo only takes (db, repoId, login) - no revalidateTag by design
  revalidateTag: undefined,
});

describe("POST /api/repos/[id]/bookmark", () => {
  beforeEach(mocks.beforeEach);
  runSharedTests();

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
