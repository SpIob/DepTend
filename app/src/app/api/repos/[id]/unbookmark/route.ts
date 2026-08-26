import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { unbookmarkRepo } from "@deptend/core/db/bookmarks.js";
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
      { error: "Sign in with GitHub to unbookmark a repo." },
      { status: 401 },
    );
  }

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

  // unbookmarkRepo() collapses "never bookmarked" and "repo doesn't exist"
  // into one outcome (see bookmarks.ts) — both are a no-op from the
  // caller's side, so there's no not_found branch to handle here, unlike
  // claim/unclaim's not_found case.
  await unbookmarkRepo(getDb(), id, login);

  return NextResponse.json({ message: "Unbookmarked.", bookmarked: false }, { status: 200 });
}
