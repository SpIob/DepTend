import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getDb } from "@/lib/db";
import { withdrawOwnRepo } from "@deptend/core/db/repos.js";
import { checkMissionActionLimit } from "@/lib/rate-limit";
import { gateRequest } from "@/lib/route-gate";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gated = await gateRequest({
    request,
    params,
    rateLimiter: checkMissionActionLimit,
    authMessage: "Sign in with GitHub to withdraw a repo submission.",
    rateLimitMessage: "Too many actions. Try again shortly.",
    invalidIdMessage: "Invalid repo id.",
  });
  if (!gated.ok) {
    return gated.response;
  }
  const { id, login } = gated;

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
