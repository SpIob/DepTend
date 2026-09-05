import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { unbookmarkRepo } from "@deptend/core/db/bookmarks.js";
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
    authMessage: "Sign in with GitHub to unbookmark a repo.",
    rateLimitMessage: "Too many actions. Try again shortly.",
    invalidIdMessage: "Invalid repo id.",
  });
  if (!gated.ok) {
    return gated.response;
  }
  const { id, login } = gated;

  // unbookmarkRepo() collapses "never bookmarked" and "repo doesn't exist"
  // into one outcome (see bookmarks.ts) — both are a no-op from the
  // caller's side, so there's no not_found branch to handle here, unlike
  // claim/unclaim's not_found case.
  await unbookmarkRepo(getDb(), id, login);

  return NextResponse.json({ message: "Unbookmarked.", bookmarked: false }, { status: 200 });
}
