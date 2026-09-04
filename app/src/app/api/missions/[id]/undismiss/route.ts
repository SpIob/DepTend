import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { undismissMission } from "@deptend/core/db/missions.js";
import { isValidUuid } from "@deptend/core/db/validation.js";
import { checkMissionActionLimit } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/request-origin";

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
      { error: "Sign in with GitHub to restore a dismissed mission." },
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

  const { id } = await params;
  if (!isValidUuid(id)) {
    return NextResponse.json({ error: "Invalid mission id." }, { status: 400 });
  }

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
