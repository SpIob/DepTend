import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getDb } from "@/lib/db";
import { unsubscribeFromRepo } from "@deptend/core/notifications/subscriptions.js";
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
    authMessage: "Sign in with GitHub to manage notifications.",
    rateLimitMessage: "Too many actions. Try again shortly.",
    invalidIdMessage: "Invalid repo id.",
  });
  if (!gated.ok) {
    return gated.response;
  }
  const { id, login } = gated;
  const repoId = id;

  const db = getDb();
  const removed = await unsubscribeFromRepo(db, login, repoId);

  if (!removed) {
    return NextResponse.json({ error: "Subscription not found." }, { status: 404 });
  }

  revalidateTag("repos");

  return NextResponse.json({ message: "Unsubscribed from notifications." });
}
