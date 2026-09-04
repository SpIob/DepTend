/**
 * Shared route test helpers for mutating API routes.
 *
 * Provides common test logic (runSharedTests, runSuccessTest, etc.)
 * but each test file must set up its own mocks at the top level
 * because vitest's vi.mock macro only works at module top level.
 */

import { vi, describe, it, expect } from "vitest";

/** Sentinel for the readonly DB mock. */
export const DB = { __readonlyDbSentinel: true } as const;

/** A valid UUID string for test params. */
export const VALID_ID = "123e4567-e89b-12d3-a456-426614174000";

export interface RouteTestHelpers {
  /** Mock control - call beforeEach to reset all mocks. */
  mocks: {
    beforeEach: () => void;
  };
  /** Sign in a user and return their login. */
  signedIn: (login?: string) => string;
  /** Make a POST request to the route and return the response. */
  post: (id: string, body?: unknown) => Promise<Response>;
  /** Run the 5 shared gate tests (403, 401, 429, 400). */
  runSharedTests: () => void;
  /** Run a success test with the given options. */
  runSuccessTest: (options: SuccessTestOptions) => void;
  /** Run a failure test that expects no revalidation. */
  runFailureNoRevalidateTest: (outcome: string, description: string) => void;
}

export interface SuccessTestOptions {
  description: string;
  outcome: string;
  expectedStatus: number;
  expectedMessage?: string;
  expectedRevalidateTags?: string[];
  beforeCall?: () => void;
}

type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface CreateHarnessOptions {
  /** The route's POST handler to test. */
  handler: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  /** The rate limiter to use (checkMissionActionLimit or checkRepoSubmissionLimit). */
  rateLimiter: (key: string) => RateLimitResult;
  /** Base URL for POST requests (without the ID param). */
  baseUrl: string;
  /** Custom POST request builder. Default builds a same-origin JSON POST. */
  buildRequest?: (id: string, body?: unknown) => Request;
  /** Function to create the expected core call args for success tests. */
  makeCoreCallArgs?: (login: string, id: string) => unknown[];
  /** Expected revalidate tags on success. Default: ["missions", "repos"]. */
  successRevalidateTags?: string[];
  /** The mocked core function (from vi.mock). */
  coreFn: ReturnType<typeof vi.fn>;
  /** The mocked revalidateTag function (if mocked). */
  revalidateTag?: ReturnType<typeof vi.fn> | undefined;
  /** The mocked getServerSession function (from vi.mock). */
  getServerSession: ReturnType<typeof vi.fn>;
  /** The mocked getDb function (from vi.mock). */
  getDb: ReturnType<typeof vi.fn>;
}

/**
 * Creates a test harness for a mutating route.
 *
 * The test file MUST set up its own mocks at the top level using vi.hoisted/vi.mock,
 * then pass the mocked functions to this function.
 */
export function createRouteTestHarness({
  handler,
  rateLimiter,
  baseUrl,
  buildRequest,
  makeCoreCallArgs = (login: string, id: string): unknown[] => [DB, id, login],
  successRevalidateTags = ["missions", "repos"],
  coreFn,
  revalidateTag,
  getServerSession,
  getDb,
}: CreateHarnessOptions): RouteTestHelpers {
  const defaultRequest = (id: string, body?: unknown): Request => {
    const url = `${baseUrl}/${id}`;
    const headers: Record<string, string> = {
      origin: "http://localhost",
      host: "localhost",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    return new Request(url, {
      method: "POST",
      headers,
      ...(body !== undefined
        ? { body: typeof body === "string" ? body : JSON.stringify(body) }
        : {}),
    });
  };

  const makeRequest = buildRequest ?? defaultRequest;

  const post = async (id: string, body?: unknown): Promise<Response> => {
    const request = makeRequest(id, body);
    return handler(request, { params: Promise.resolve({ id }) });
  };

  function signedIn(login = `user-${crypto.randomUUID()}`): string {
    getServerSession.mockResolvedValue({ user: { login } });
    getDb.mockReturnValue(DB);
    return login;
  }

  function runSharedTests(): void {
    describe("shared gate tests", () => {
      it("returns 403 for a cross-origin POST before any other gate", async () => {
        signedIn();
        const response = await handler(
          new Request(baseUrl, {
            method: "POST",
            headers: { origin: "https://evil.example", host: "localhost" },
            ...(buildRequest ? {} : { body: JSON.stringify({}) }),
          }),
          { params: Promise.resolve({ id: VALID_ID }) },
        );
        expect(response.status).toBe(403);
        expect(coreFn).not.toHaveBeenCalled();
      });

      it("returns 401 with no session", async () => {
        getServerSession.mockResolvedValue(null);
        const request = makeRequest(VALID_ID);
        const response = await handler(request, { params: Promise.resolve({ id: VALID_ID }) });
        expect(response.status).toBe(401);
        expect(coreFn).not.toHaveBeenCalled();
      });

      it("returns 429 once the rate-limit budget is exhausted", async () => {
        const login = signedIn();
        for (let i = 0; i < 20; i++) {
          rateLimiter(login);
        }
        const request = makeRequest(VALID_ID);
        const response = await handler(request, { params: Promise.resolve({ id: VALID_ID }) });
        expect(response.status).toBe(429);
        expect(
          Number.parseInt(response.headers.get("Retry-After") ?? "0", 10),
        ).toBeGreaterThanOrEqual(1);
        expect(coreFn).not.toHaveBeenCalled();
      });

      it("returns 400 for a malformed id before touching the DB", async () => {
        signedIn();
        const request = makeRequest("not-a-uuid");
        const response = await handler(request, { params: Promise.resolve({ id: "not-a-uuid" }) });
        expect(response.status).toBe(400);
        expect(coreFn).not.toHaveBeenCalled();
      });
    });
  }

  function runSuccessTest(options: SuccessTestOptions): void {
    const {
      description,
      outcome,
      expectedStatus,
      expectedMessage,
      expectedRevalidateTags = successRevalidateTags,
      beforeCall,
    } = options;

    it(description, async () => {
      const login = signedIn();
      if (beforeCall) beforeCall();
      coreFn.mockResolvedValue(outcome);
      const request = makeRequest(VALID_ID);
      const response = await handler(request, { params: Promise.resolve({ id: VALID_ID }) });
      expect(response.status).toBe(expectedStatus);
      expect(coreFn).toHaveBeenCalledWith(...makeCoreCallArgs(login, VALID_ID));
      if (expectedMessage) {
        const data = (await response.json()) as { message?: string };
        expect(data.message).toBe(expectedMessage);
      }
      if (revalidateTag) {
        for (const tag of expectedRevalidateTags) {
          expect(revalidateTag).toHaveBeenCalledWith(tag);
        }
      }
    });
  }

  function runFailureNoRevalidateTest(outcome: string, description: string): void {
    it(description, async () => {
      signedIn();
      coreFn.mockResolvedValue(outcome);
      const request = makeRequest(VALID_ID);
      await handler(request, { params: Promise.resolve({ id: VALID_ID }) });
      if (revalidateTag) {
        expect(revalidateTag).not.toHaveBeenCalled();
      }
    });
  }

  return {
    mocks: {
      beforeEach: (): void => {
        vi.resetAllMocks();
      },
    },
    signedIn,
    post,
    runSharedTests,
    runSuccessTest,
    runFailureNoRevalidateTest,
  };
}
