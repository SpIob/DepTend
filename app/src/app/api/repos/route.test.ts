/**
 * Route-level tests for POST /api/repos — the submission path. This is the
 * route with the most HTTP surface in the project: auth gate, its own
 * 5/hour rate bucket, body/URL validation, the duplicate short-circuits
 * (cheap exact-case lookup before the network, canonical lookup after),
 * the manifest pre-check's four-reason status mapping (ADR 0030's
 * correction), submitRepo()'s three outcomes including the repo cap, and
 * the best-effort ingestion dispatch.
 *
 * parseGithubUrl is NOT mocked (real implementation — it's pure); only
 * network/DB-touching boundaries are: getRepoByOwnerAndName,
 * checkSubmittableRepo, and triggerIngestion. NEXT_PUBLIC_MAX_REPOS is
 * stubbed so the cap assertion doesn't depend on the shell environment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { checkRepoSubmissionLimit } from "@/lib/rate-limit";

const getServerSession = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

const getDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ getDb }));

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag }));

const getRepoByOwnerAndName = vi.hoisted(() => vi.fn());
const submitRepo = vi.hoisted(() => vi.fn());
vi.mock("@deptend/core/db/repos.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRepoByOwnerAndName,
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
    // Same-origin Origin+Host pair on every request — exercises the route's
    // origin gate's positive path; its negative path has its own case below.
    headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
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

/** Canonical GitHubRepoMeta-shaped payload — the route reads owner/name off it post-pre-check. */
function makeMeta(): Record<string, unknown> {
  return { full_name: "octocat/Hello-World", owner: { login: "octocat" }, name: "Hello-World" };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Default: no existing repo row for either duplicate check. Individual
  // tests override this to exercise the short-circuit paths.
  getRepoByOwnerAndName.mockResolvedValue(null);
  // Deterministic regardless of the developer's/CI's shell env: no token
  // (pre-check runs unauthenticated → core receives null), cap pinned at 150.
  vi.stubEnv("GITHUB_TOKEN", undefined);
  vi.stubEnv("NEXT_PUBLIC_MAX_REPOS", "150");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/repos", () => {
  it("returns 403 for a cross-origin POST before any other gate", async () => {
    signedIn();
    const response = await POST(
      new Request("http://localhost/api/repos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          host: "localhost",
        },
        body: JSON.stringify({ githubUrl: "https://github.com/a/b" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(checkSubmittableRepo).not.toHaveBeenCalled();
    expect(submitRepo).not.toHaveBeenCalled();
  });

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

  it("short-circuits an exact-case duplicate before the network pre-check", async () => {
    signedIn();
    const repo = makeRepo();
    getRepoByOwnerAndName.mockResolvedValue(repo);

    const response = await POST(postJson({ githubUrl: "https://github.com/octocat/Hello-World" }));

    expect(response.status).toBe(200);
    // The whole point of this check: no GitHub API budget spent re-verifying
    // a repo we already index.
    expect(checkSubmittableRepo).not.toHaveBeenCalled();
    expect(submitRepo).not.toHaveBeenCalled();
    expect(getRepoByOwnerAndName).toHaveBeenCalledWith(DB, "octocat", "Hello-World");
    const data = (await response.json()) as { message?: string; repo?: unknown };
    expect(data.message).toContain("already been submitted");
    expect(data.repo).toEqual(JSON.parse(JSON.stringify(repo)));
  });

  it("catches a case-variant duplicate via canonical metadata after the pre-check", async () => {
    signedIn();
    const repo = makeRepo();
    // First lookup (raw parsed casing) misses; the post-pre-check lookup
    // against canonical owner/name finds the row.
    getRepoByOwnerAndName.mockResolvedValueOnce(null).mockResolvedValueOnce(repo);
    checkSubmittableRepo.mockResolvedValue({
      ok: true,
      ecosystem: "npm",
      meta: { full_name: "octocat/Hello-World", owner: { login: "octocat" }, name: "Hello-World" },
    });

    const response = await POST(postJson({ githubUrl: "https://github.com/OCTOCAT/HELLO-WORLD" }));

    expect(response.status).toBe(200);
    expect(submitRepo).not.toHaveBeenCalled();
    expect(triggerIngestion).not.toHaveBeenCalled();
    expect(getRepoByOwnerAndName).toHaveBeenNthCalledWith(2, DB, "octocat", "Hello-World");
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

  it("submits with canonical URL parts, the caller's login, and the configured cap on success", async () => {
    signedIn("submitter-login");
    // GitHub resolves owner/repo names case-insensitively; the pre-check's
    // metadata is canonical. A user-submitted "OctoCat" casing must NOT be
    // what lands in the DB — scripts/ingest.js writes back
    // ghMeta.full_name, and a casing mismatch would fork the row into two.
    checkSubmittableRepo.mockResolvedValue({
      ok: true,
      ecosystem: "npm",
      meta: { full_name: "octocat/Hello-World", owner: { login: "octocat" }, name: "Hello-World" },
    });
    const repo = makeRepo();
    submitRepo.mockResolvedValue({ outcome: "created", repo });
    triggerIngestion.mockResolvedValue({ ok: true });

    const response = await POST(
      postJson({ githubUrl: "https://github.com/OctoCat/Hello-World.git" }),
    );

    expect(response.status).toBe(201);
    expect(submitRepo).toHaveBeenCalledWith(DB, {
      githubUrl: "https://github.com/octocat/Hello-World",
      owner: "octocat",
      name: "Hello-World",
      submittedBy: "submitter-login",
      maxRepos: 150,
    });
    // The pre-check itself still receives the raw parsed parts — it is the
    // thing resolving them to canonical form.
    expect(checkSubmittableRepo).toHaveBeenCalledWith("OctoCat", "Hello-World", null);
    expect(triggerIngestion).toHaveBeenCalledWith(repo.id);

    const data = (await response.json()) as { message?: string; repo?: unknown };
    expect(data.message).toContain("ingestion has been triggered");
    // Compare in wire form — NextResponse.json serializes Date fields to
    // ISO strings, so the raw fixture (with Date instances) isn't equal.
    expect(data.repo).toEqual(JSON.parse(JSON.stringify(repo)));
    // Creation invalidates the directory/count caches (ADR 0033).
    expect(revalidateTag).toHaveBeenCalledWith("repos");
    expect(revalidateTag).not.toHaveBeenCalledWith("missions");
  });

  it("maps cap_reached to 409 without dispatching ingestion", async () => {
    signedIn();
    checkSubmittableRepo.mockResolvedValue({ ok: true, ecosystem: "npm", meta: makeMeta() });
    submitRepo.mockResolvedValue({ outcome: "cap_reached", repo: null });
    const response = await POST(postJson({ githubUrl: "https://github.com/a/b" }));
    expect(response.status).toBe(409);
    expect(triggerIngestion).not.toHaveBeenCalled();
  });

  it("maps already_exists to 200 without re-dispatching", async () => {
    signedIn();
    checkSubmittableRepo.mockResolvedValue({ ok: true, ecosystem: "npm", meta: makeMeta() });
    const repo = makeRepo();
    submitRepo.mockResolvedValue({ outcome: "already_exists", repo });
    const response = await POST(postJson({ githubUrl: "https://github.com/a/b" }));
    expect(response.status).toBe(200);
    expect(triggerIngestion).not.toHaveBeenCalled();
  });

  it("still returns 201 with a cron fallback message when the dispatch fails — and logs why", async () => {
    signedIn();
    checkSubmittableRepo.mockResolvedValue({ ok: true, ecosystem: "npm", meta: makeMeta() });
    const repo = makeRepo();
    submitRepo.mockResolvedValue({ outcome: "created", repo });
    triggerIngestion.mockResolvedValue({ ok: false, error: "GitHub API returned 404" });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await POST(postJson({ githubUrl: "https://github.com/a/b" }));
    expect(response.status).toBe(201);
    const data = (await response.json()) as { message?: string };
    expect(data.message).toContain("next scheduled run");
    // The dispatch failure must leave evidence — an expired
    // GH_DISPATCH_TOKEN otherwise looks like nothing broke.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(repo.id);
    expect(warn.mock.calls[0]?.[0]).toContain("GitHub API returned 404");
    warn.mockRestore();
  });

  it("returns 500 if a created outcome somehow carries no repo row", async () => {
    signedIn();
    checkSubmittableRepo.mockResolvedValue({ ok: true, ecosystem: "npm", meta: makeMeta() });
    submitRepo.mockResolvedValue({ outcome: "created", repo: null });
    const response = await POST(postJson({ githubUrl: "https://github.com/a/b" }));
    expect(response.status).toBe(500);
    expect(triggerIngestion).not.toHaveBeenCalled();
  });
});
