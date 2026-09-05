import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getDb } from "@/lib/db";
import { unclaimMission } from "@deptend/core/db/missions.js";
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
    authMessage: "Sign in with GitHub to unclaim a mission.",
    rateLimitMessage: "Too many mission actions. Try again shortly.",
    invalidIdMessage: "Invalid mission id.",
  });
  if (!gated.ok) {
    return gated.response;
  }
  const { id, login } = gated;

  const outcome = await unclaimMission(getDb(), id, login);

  if (outcome === "not_found") {
    return NextResponse.json({ error: "Mission not found." }, { status: 404 });
  }

  if (outcome === "not_claimed_by_you") {
    return NextResponse.json(
      { error: "This mission isn't currently claimed by you." },
      { status: 409 },
    );
  }

  // Unclaims change both cached views: the board (this mission's row) and the
  // directory (per-repo severity counts include open+claimed). ADR 0033.
  revalidateTag("missions");
  revalidateTag("repos");

  return NextResponse.json({ message: "Unclaimed.", status: "open" }, { status: 200 });
}
