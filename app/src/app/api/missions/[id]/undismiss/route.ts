import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getDb } from "@/lib/db";
import { undismissMission } from "@deptend/core/db/missions.js";
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
    authMessage: "Sign in with GitHub to restore a dismissed mission.",
    rateLimitMessage: "Too many mission actions. Try again shortly.",
    invalidIdMessage: "Invalid mission id.",
  });
  if (!gated.ok) {
    return gated.response;
  }
  const { id } = gated;

  const outcome = await undismissMission(getDb(), id);

  if (outcome === "not_found") {
    return NextResponse.json({ error: "Mission not found." }, { status: 404 });
  }

  if (outcome === "not_dismissed") {
    return NextResponse.json({ error: "This mission isn't dismissed." }, { status: 409 });
  }

  // Restoring re-enters both cached views: the board (the mission's row
  // returns) and the directory (per-repo severity counts include
  // open+claimed). ADR 0033.
  revalidateTag("missions");
  revalidateTag("repos");

  return NextResponse.json({ message: "Restored to open.", status: "open" }, { status: 200 });
}
