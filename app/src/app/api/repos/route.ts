import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getRepoByOwnerAndName, parseGithubUrl, submitRepo } from "@deptend/core/db/repos.js";
import { checkSubmittableRepo } from "@deptend/core/ingestor/manifest-check.js";
import { triggerIngestion } from "@/lib/github-dispatch";
import { checkRepoSubmissionLimit } from "@/lib/rate-limit";

interface SubmitBody {
  githubUrl?: unknown;
}

function isSubmitBody(value: unknown): value is SubmitBody {
  return typeof value === "object" && value !== null;
}

export async function POST(request: Request): Promise<Response> {
  const session = await getServerSession(authOptions);
  const login = session?.user?.login;
  if (login === undefined) {
    return NextResponse.json({ error: "Sign in with GitHub to submit a repo." }, { status: 401 });
  }

  const rateLimit = checkRepoSubmissionLimit(login);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many repo submissions. Try again later." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const githubUrlInput =
    isSubmitBody(body) && typeof body.githubUrl === "string" ? body.githubUrl : null;
  if (githubUrlInput === null || githubUrlInput.trim() === "") {
    return NextResponse.json({ error: "githubUrl is required." }, { status: 400 });
  }

  const parsed = parseGithubUrl(githubUrlInput);
  if (parsed === null) {
    return NextResponse.json(
      { error: "That doesn't look like a public GitHub repo URL (github.com/owner/repo)." },
      { status: 400 },
    );
  }

  // Cheap duplicate check before anything touches the network: a
  // re-submission of an already-indexed URL otherwise pays the full
  // manifest pre-check out of a GitHub API budget that runs
  // unauthenticated in production today (60 req/hr shared across all of
  // /app's traffic). Case-variant duplicates can't be caught here — the
  // stored row may use different casing than this URL — so a second,
  // canonical check follows the pre-check below.
  const exactCaseMatch = await getRepoByOwnerAndName(getDb(), parsed.owner, parsed.name);
  if (exactCaseMatch !== null) {
    return NextResponse.json(
      { message: "This repo has already been submitted.", repo: exactCaseMatch },
      { status: 200 },
    );
  }

  // Manifest pre-check (Roadmap "Now #4", Option A) — reject before a row
  // (and a cap slot) is created at all, rather than letting a repo with no
  // analyzable manifest quietly land as ingestionStatus: "skipped" later.
  //
  // Reuses GITHUB_TOKEN — already in .env.example for exactly this purpose
  // ("avoid 60 req/hr rate limit"), already used by scripts/ingest.js and
  // the CLI for the identical fetchGitHubRepoMeta call. Not previously
  // read anywhere in /app, though, so the real, honest decision point
  // isn't "invent a token" — it's whether GITHUB_TOKEN is actually set as
  // a Vercel env var (distinct from GitHub Actions' own auto-injected
  // GITHUB_TOKEN, which only exists inside Actions runs and was never
  // available here). If it isn't set in Vercel, this runs unauthenticated
  // (60 req/hr, shared globally across all of /app's traffic, not
  // per-user) — flagged here, not silently assumed either way.
  // GH_DISPATCH_TOKEN is deliberately NOT used for this: it's a
  // fine-grained PAT scoped to this project's own repo for
  // workflow_dispatch, and fine-grained PATs 403 on repos outside their
  // grant list even when the target repo is public.
  const manifestCheck = await checkSubmittableRepo(
    parsed.owner,
    parsed.name,
    process.env.GITHUB_TOKEN ?? null,
  );
  if (!manifestCheck.ok) {
    switch (manifestCheck.reason) {
      case "no_manifest":
        return NextResponse.json({ error: manifestCheck.message }, { status: 400 });
      case "not_found":
        // The repo itself doesn't exist, is private, or was typo'd — a
        // problem with the request, not a transient failure on our end.
        // This is the exact case ADR 0030's "byproduct" note describes.
        // 503 ("try again later") was actively misleading here: retrying
        // does nothing for a repo that was never there to begin with.
        return NextResponse.json({ error: manifestCheck.message }, { status: 404 });
      case "rate_limited":
      case "verification_failed":
        // Genuinely transient — our own call to the GitHub API hit a rate
        // limit or failed unexpectedly. "Try again later" is the correct
        // instruction here, unlike the not_found case above.
        return NextResponse.json({ error: manifestCheck.message }, { status: 503 });
    }
  }

  // GitHub treats owner/repo casing as insignificant; Postgres doesn't.
  // Store — and dedup on — the canonical casing the API just returned,
  // which is exactly what scripts/ingest.js writes back on every run
  // (ghMeta.full_name). Submitting raw parsed values instead lets a
  // "Foo/bar" submission coexist with the writer's canonical "foo/BAR":
  // two rows for one real repo, the first stranded at "pending" and
  // re-picked by resolvePending() on every cron run forever.
  const canonical = await getRepoByOwnerAndName(
    getDb(),
    manifestCheck.meta.owner.login,
    manifestCheck.meta.name,
  );
  if (canonical !== null) {
    return NextResponse.json(
      { message: "This repo has already been submitted.", repo: canonical },
      { status: 200 },
    );
  }

  const maxRepos = Number.parseInt(process.env.NEXT_PUBLIC_MAX_REPOS ?? "150", 10);

  const result = await submitRepo(getDb(), {
    githubUrl: `https://github.com/${manifestCheck.meta.owner.login}/${manifestCheck.meta.name}`,
    owner: manifestCheck.meta.owner.login,
    name: manifestCheck.meta.name,
    submittedBy: login,
    maxRepos,
  });

  if (result.outcome === "cap_reached") {
    return NextResponse.json(
      { error: `deptend.dev indexes a maximum of ${maxRepos.toString()} repos during MVP.` },
      { status: 409 },
    );
  }

  if (result.outcome === "already_exists") {
    return NextResponse.json(
      { message: "This repo has already been submitted.", repo: result.repo },
      { status: 200 },
    );
  }

  // created — result.repo is guaranteed non-null for this outcome
  const repo = result.repo;
  if (repo === null) {
    return NextResponse.json({ error: "Unexpected error creating repo." }, { status: 500 });
  }

  // A new row changes the directory, the counts, and the cap check's
  // denominator — all cached under the "repos" tag (ADR 0033).
  revalidateTag("repos");

  const dispatch = await triggerIngestion(repo.id);
  if (!dispatch.ok) {
    // Best-effort by design — degrade to the next cron run, but leave
    // evidence. Without this line an expired GH_DISPATCH_TOKEN looks like
    // nothing broke while every submission quietly waits up to 24h.
    console.warn(
      `[api/repos] ingestion dispatch failed for ${repo.id}: ${dispatch.error ?? "unknown error"}`,
    );
  }

  return NextResponse.json(
    {
      message: dispatch.ok
        ? "Submitted — ingestion has been triggered and should complete shortly."
        : "Submitted — will be processed on the next scheduled run (immediate trigger unavailable).",
      repo,
    },
    { status: 201 },
  );
}
