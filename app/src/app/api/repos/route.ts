import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { parseGithubUrl, submitRepo } from "@deptend/core/db/repos.js";
import { triggerIngestion } from "@/lib/github-dispatch";

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

  const maxRepos = Number.parseInt(process.env.NEXT_PUBLIC_MAX_REPOS ?? "10", 10);

  const result = await submitRepo(getDb(), {
    githubUrl: parsed.githubUrl,
    owner: parsed.owner,
    name: parsed.name,
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

  const dispatch = await triggerIngestion(repo.id);

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
