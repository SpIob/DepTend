import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { unsubscribeFromRepo } from "@deptend/core/notifications/subscriptions.js";
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
      { error: "Sign in with GitHub to manage notifications." },
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

  const { id: repoId } = await params;
  if (!isValidUuid(repoId)) {
    return NextResponse.json({ error: "Invalid repo id." }, { status: 400 });
  }

  const db = getDb();
  const removed = await unsubscribeFromRepo(db, login, repoId);

  if (!removed) {
    return NextResponse.json({ error: "Subscription not found." }, { status: 404 });
  }

  revalidateTag("repos");

  return NextResponse.json({ message: "Unsubscribed from notifications." });
}
