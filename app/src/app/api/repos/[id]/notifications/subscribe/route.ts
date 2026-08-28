import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { subscribeToRepo } from "@deptend/core/notifications/subscriptions.js";
import { isValidUuid } from "@deptend/core/db/validation.js";
import { checkMissionActionLimit } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/request-origin";

interface SubscribeBody {
  eventTypes?: string[];
}

function isSubscribeBody(value: unknown): value is SubscribeBody {
  return typeof value === "object" && value !== null;
}

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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const eventTypes =
    isSubscribeBody(body) && Array.isArray(body.eventTypes) ? body.eventTypes : undefined;

  try {
    const db = getDb();
    const subscription = await subscribeToRepo(db, {
      userLogin: login,
      repoId,
      ...(eventTypes !== undefined && { eventTypes }),
    });

    revalidateTag("repos");

    return NextResponse.json(
      { message: "Subscribed to notifications.", subscription },
      { status: 201 },
    );
  } catch (err) {
    console.error("[notifications/subscribe] error:", err);
    return NextResponse.json({ error: "Failed to subscribe to notifications." }, { status: 500 });
  }
}
