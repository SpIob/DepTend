import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getDb } from "@/lib/db";
import { dismissMission } from "@deptend/core/db/missions.js";
import { checkMissionActionLimit } from "@/lib/rate-limit";
import { gateRequest } from "@/lib/route-gate";
import { parseOptionalJsonBody } from "@/lib/body-parse";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gated = await gateRequest({
    request,
    params,
    rateLimiter: checkMissionActionLimit,
    authMessage: "Sign in with GitHub to dismiss a mission.",
    rateLimitMessage: "Too many mission actions. Try again shortly.",
    invalidIdMessage: "Invalid mission id.",
  });
  if (!gated.ok) {
    return gated.response;
  }
  const { id } = gated;

  // Optional bounded plain-text reason. A missing or malformed JSON body
  // must not fail the dismissal — only a body that parses but carries a
  // non-string reason is rejected.
  let reason: string | null = null;
  const body = await parseOptionalJsonBody(request);
  if (typeof body === "object" && body !== null && "reason" in body) {
    const raw = (body as { reason?: unknown }).reason;
    if (typeof raw !== "string") {
      return NextResponse.json({ error: "reason must be a string." }, { status: 400 });
    }
    const trimmed = raw.trim();
    reason = trimmed === "" ? null : trimmed.slice(0, 500);
  }

  const outcome = await dismissMission(getDb(), id, reason);

  if (outcome === "not_found") {
    return NextResponse.json({ error: "Mission not found." }, { status: 404 });
  }

  if (outcome === "not_open") {
    return NextResponse.json(
      { error: "Only open missions can be dismissed — unclaim it first." },
      { status: 409 },
    );
  }

  // Dismissals change both cached views: the board (this mission's row
  // leaves it) and the directory (per-repo severity counts include
  // open+claimed). ADR 0033.
  revalidateTag("missions");
  revalidateTag("repos");

  return NextResponse.json({ message: "Dismissed.", status: "dismissed" }, { status: 200 });
}
