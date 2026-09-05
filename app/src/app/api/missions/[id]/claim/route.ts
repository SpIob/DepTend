import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getDb } from "@/lib/db";
import { claimMission } from "@deptend/core/db/missions.js";
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
    authMessage: "Sign in with GitHub to claim a mission.",
    rateLimitMessage: "Too many mission actions. Try again shortly.",
    invalidIdMessage: "Invalid mission id.",
  });
  if (!gated.ok) {
    return gated.response;
  }
  const { id, login } = gated;

  const outcome = await claimMission(getDb(), id, login);

  if (outcome === "not_found") {
    return NextResponse.json({ error: "Mission not found." }, { status: 404 });
  }

  if (outcome === "already_claimed") {
    return NextResponse.json({ error: "This mission has already been claimed." }, { status: 409 });
  }

  // Claims change both cached views: the board (this mission's row) and the
  // directory (per-repo severity counts include open+claimed). ADR 0033.
  revalidateTag("missions");
  revalidateTag("repos");

  return NextResponse.json(
    { message: "Claimed.", status: "claimed", claimedBy: login },
    { status: 200 },
  );
}
