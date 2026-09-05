import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { bookmarkRepo } from "@deptend/core/db/bookmarks.js";
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
    authMessage: "Sign in with GitHub to bookmark a repo.",
    rateLimitMessage: "Too many actions. Try again shortly.",
    invalidIdMessage: "Invalid repo id.",
  });
  if (!gated.ok) {
    return gated.response;
  }
  const { id, login } = gated;

  const outcome = await bookmarkRepo(getDb(), id, login);

  if (outcome === "not_found") {
    return NextResponse.json({ error: "Repo not found." }, { status: 404 });
  }

  return NextResponse.json({ message: "Bookmarked.", bookmarked: true }, { status: 200 });
}
