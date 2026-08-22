/**
 * Route-level tests for POST /api/repos — the submission path. This is the
 * route with the most HTTP surface in the project: auth gate, its own
 * 5/hour rate bucket, body/URL validation, the manifest pre-check's
 * four-reason status mapping (ADR 0030's correction), submitRepo()'s three
 * outcomes including the repo cap, and the best-effort ingestion dispatch.
 *
 * parseGithubUrl is NOT mocked (real implementation — it's pure); only
 * network-touching boundaries are: checkSubmittableRepo and
 * triggerIngestion. NEXT_PUBLIC_MAX_REPOS is stubbed so the cap assertion
 * doesn't depend on the shell environment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { checkRepoSubmissionLimit } from "@/lib/rate-limit";

const getServerSession = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

const getDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ getDb }));

const submitRepo = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/repos.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitRepo,
}));

const checkSubmittableRepo = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/ingestor/manifest-check.js", () => ({ checkSubmittableRepo }));

const triggerIngestion = vi.hoisted(() => vi.fn());
vi.mock("@/lib/github-dispatch", () => ({ triggerIngestion }));

const DB = { __readonlyDbSentinel: true } as const;

function signedIn(login = `user-${crypto.randomUUID()}`): string {
  getServerSession.mockResolvedValue({ user: { login } });
  getDb.mockReturnValue(DB);
  return login;
}

function postJson(body: unknown): Request {
  return new Request("http://localhost/api/repos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A Repo-shaped row — the full $inferSelect shape routes pass through opaquely. */
function makeRepo(): Record<string, unknown> {
  return {
    id: "223e4567-e89b-12d3-a456-426614174000",
    githubUrl: "https://github.com/octocat/Hello-World",
    owner: "octocat",
    name: "Hello-World",
    defaultBranch: "main",
    description: null,
    stars: 0,
    openIssuesCount: 0,
    topics: [],
    homepageUrl: null,
    ingestionStatus: "pending",
    lastIngestedAt: null,
    ingestionError: null,
    submittedBy: "octocat-submitter",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Deterministic regardless of the developer's/CI's shell env: no token
  // (pre-check runs unauthenticated → core receives null), cap pinned at 150.
  vi.stubEnv("GITHUB_TOKEN", undefined);
  vi.stubEnv("NEXT_PUBLIC_MAX_REPOS", "150");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/repos", () => {
  it("returns 401 with no session", async () => {
    getServerSession.mockResolvedValue(null);
    const response = await POST(postJson({ githubUrl: "https://github.com/a/b" }));
    expect(response.status).toBe(401);
    expect(checkSubmittableRepo).not.toHaveBeenCalled();
    expect(submitRepo).not.toHaveBeenCalled();
  });

  it("returns 429 once the per-hour submission budget is exhausted", async () => {
    const login = signedIn();
    for (let i = 0; i < 5; i++) {
      checkRepoSubmissionLimit(login);
    }
    const response = await POST(postJson({ githubUrl: "https://github.com/a/b" }));
    expect(response.status).toBe(429);
    expect(Number.parseInt(response.headers.get("Retry-After") ?? "0", 10)).toBeGreaterThanOrEqual(
      1,
    );
    expect(submitRepo).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-JSON body", async () => {
    signedIn();
    const response = await POST(postJson("this is not json"));
    expect(response.status).toBe(400);
  });

  it("returns 400 when githubUrl is missing or empty", async () => {
    signedIn();
    expect((await POST(postJson({}))).status).toBe(400);
    expect((await POST(postJson({ githubUrl: "" }))).status).toBe(400);
  });

  it("returns 400 for a URL that isn't a public GitHub repo", async () => {
    signedIn();
    const response = await POST(postJson({ githubUrl: "https://gitlab.com/a/b" }));
    expect(response.status).toBe(400);
    expect(checkSubmittableRepo).not.toHaveBeenCalled();
  });

  it("maps no_manifest to 400 without creating a row", async () => {
    signedIn();
    checkSubmittableRepo.mockResolvedValue({
      ok: false,
      reason: "no_manifest",
      message: "No analyzable manifest.",
    });
    const response = await POST(postJson({ githubUrl: "https://github.com/a/b" }));
    expect(response.status).toBe(400);
    expect(submitRepo).not.toHaveBeenCalled();
  });

  it("maps not_found to 404 — a private/deleted repo must not say 'try again later'", async () => {
    signedIn();
    checkSubmittableRepo.mockResolvedValue({
      ok: false,
      reason: "not_found",
      message: "Repo not found.",
    });
    const response = await POST(postJson({ githubUrl: "https://github.com/a/b" }));
    expect(response.status).toBe(404);
    expect(submitRepo).not.toHaveBeenCalled();
  });

  it("maps rate_limited and verification_failed to 503", async () => {
    signedIn();

    checkSubmittableRepo.mockResolvedValue({
      ok: false,
      reason: "rate_limited",
      message: "Rate limited.",
    });
    expect((await POST(postJson({ githubUrl: "https://github.com/a/b" }))).status).toBe(503);

    checkSubmittableRepo.mockResolvedValue({
      ok: false,
      reason: "verification_failed",
      message: "Verification failed.",
    });
    expect((await POST(postJson({ githubUrl: "https://github.com/a/b" }))).status).toBe(503);

    expect(submitRepo).not.toHaveBeenCalled();
  });

  it("submits with parsed URL parts, the caller's login, and the configured cap on success", async () => {
    signedIn("submitter-login");
    checkSubmittableRepo.mockResolvedValue({ ok: true, ecosystem: "npm", meta: {} });
    const repo = makeRepo();
    submitRepo.mockResolvedValue({ outcome: "created", repo });
    triggerIngestion.mockResolvedValue({ ok: true });

    const response = await POST(
      postJson({ githubUrl: "https://github.com/OctoCat/Hello-World.git" }),
    );

    expect(response.status).toBe(201);
    expect(submitRepo).toHaveBeenCalledWith(DB, {
      githubUrl: "https://github.com/OctoCat/Hello-World",
      owner: "OctoCat",
      name: "Hello-World",
      submittedBy: "submitter-login",
      maxRepos: 150,
    });
    // Token comes straight from the environment — unset here means the
    // pre-check runs unauthenticated, exactly as in production today.
    expect(checkSubmittableRepo).toHaveBeenCalledWith("OctoCat", "Hello-World", null);
    expect(triggerIngestion).toHaveBeenCalledWith(repo.id);

    const data = (await response.json()) as { message?: string; repo?: unknown };
    expect(data.message).toContain("ingestion has been triggered");
    // Compare in wire form — NextResponse.json serializes Date fields to
    // ISO strings, so the raw fixture (with Date instances) isn't equal.
    expect(data.repo).toEqual(JSON.parse(JSON.stringify(repo)));
  });

  it("maps cap_reached to 409 without dispatching ingestion", async () => {
    signedIn();
    checkSubmittableRepo.mockResolvedValue({ ok: true, ecosystem: "npm", meta: {} });
    submitRepo.mockResolvedValue({ outcome: "cap_reached", repo: null });
    const response = await POST(postJson({ githubUrl: "https://github.com/a/b" }));
    expect(response.status).toBe(409);
    expect(triggerIngestion).not.toHaveBeenCalled();
  });

  it("maps already_exists to 200 without re-dispatching", async () => {
    signedIn();
    checkSubmittableRepo.mockResolvedValue({ ok: true, ecosystem: "npm", meta: {} });
    const repo = makeRepo();
    submitRepo.mockResolvedValue({ outcome: "already_exists", repo });
    const response = await POST(postJson({ githubUrl: "https://github.com/a/b" }));
    expect(response.status).toBe(200);
    expect(triggerIngestion).not.toHaveBeenCalled();
  });

  it("still returns 201 with a cron fallback message when the dispatch fails", async () => {
    signedIn();
    checkSubmittableRepo.mockResolvedValue({ ok: true, ecosystem: "npm", meta: {} });
    submitRepo.mockResolvedValue({ outcome: "created", repo: makeRepo() });
    triggerIngestion.mockResolvedValue({ ok: false });

    const response = await POST(postJson({ githubUrl: "https://github.com/a/b" }));
    expect(response.status).toBe(201);
    const data = (await response.json()) as { message?: string };
    expect(data.message).toContain("next scheduled run");
  });

  it("returns 500 if a created outcome somehow carries no repo row", async () => {
    signedIn();
    checkSubmittableRepo.mockResolvedValue({ ok: true, ecosystem: "npm", meta: {} });
    submitRepo.mockResolvedValue({ outcome: "created", repo: null });
    const response = await POST(postJson({ githubUrl: "https://github.com/a/b" }));
    expect(response.status).toBe(500);
    expect(triggerIngestion).not.toHaveBeenCalled();
  });
});
