import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dismissMission, isValidMissionId } from "@deptend/core/db/missions.js";
import { checkMissionActionLimit } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/request-origin";
import { parseOptionalJsonBody } from "@/lib/body-parse";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  const login = session?.user?.login;
  if (login === undefined) {
    return NextResponse.json(
      { error: "Sign in with GitHub to dismiss a mission." },
      { status: 401 },
    );
  }

  const rateLimit = checkMissionActionLimit(login);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many mission actions. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

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

  const { id } = await params;
  if (!isValidMissionId(id)) {
    return NextResponse.json({ error: "Invalid mission id." }, { status: 400 });
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
