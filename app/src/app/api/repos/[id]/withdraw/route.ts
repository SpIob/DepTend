import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { withdrawOwnRepo } from "@deptend/core/db/repos.js";
import { isValidUuid } from "@deptend/core/db/validation.js";
import { checkMissionActionLimit } from "@/lib/rate-limit";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getServerSession(authOptions);
  const login = session?.user?.login;
  if (login === undefined) {
    return NextResponse.json(
      { error: "Sign in with GitHub to withdraw a repo submission." },
      { status: 401 },
    );
  }

  // Same shared pool as claim/unclaim/bookmark/unbookmark (ADR 0027) — a
  // rare, self-correcting action, not worth its own dedicated bucket.
  const rateLimit = checkMissionActionLimit(login);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many actions. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const { id } = await params;
  if (!isValidUuid(id)) {
    return NextResponse.json({ error: "Invalid repo id." }, { status: 400 });
  }

  const outcome = await withdrawOwnRepo(getDb(), id, login);

  switch (outcome) {
    case "withdrawn":
      // Withdrawal deletes the repo and cascade-deletes its missions —
      // both cached views change (ADR 0033).
      revalidateTag("repos");
      revalidateTag("missions");
      return NextResponse.json({ message: "Submission withdrawn." }, { status: 200 });
    case "not_found":
      return NextResponse.json({ error: "Repo not found." }, { status: 404 });
    case "not_your_submission":
      return NextResponse.json(
        { error: "Only the person who submitted this repo can withdraw it." },
        { status: 403 },
      );
    case "ingestion_in_progress":
      return NextResponse.json(
        {
          error:
            "This repo is being ingested right now and can't be withdrawn mid-run — try again once it finishes.",
        },
        { status: 409 },
      );
    case "ingestion_failed_will_retry":
      return NextResponse.json(
        {
          error:
            "This submission failed and will be retried automatically on the next ingestion run — it can't be withdrawn while a retry is pending.",
        },
        { status: 409 },
      );
    case "already_indexed":
      return NextResponse.json(
        {
          error:
            "This repo has already been indexed and may carry real missions — it can no longer be self-withdrawn.",
        },
        { status: 409 },
      );
  }
}
