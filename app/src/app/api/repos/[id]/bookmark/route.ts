import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { bookmarkRepo } from "@deptend/core/db/bookmarks.js";
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
    return NextResponse.json({ error: "Sign in with GitHub to bookmark a repo." }, { status: 401 });
  }

  // Same pool claim/unclaim share — a bookmark toggle is the same class of
  // lightweight per-user action (ADR 0027), not worth a dedicated bucket.
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

  const outcome = await bookmarkRepo(getDb(), id, login);

  if (outcome === "not_found") {
    return NextResponse.json({ error: "Repo not found." }, { status: 404 });
  }

  return NextResponse.json({ message: "Bookmarked.", bookmarked: true }, { status: 200 });
}
