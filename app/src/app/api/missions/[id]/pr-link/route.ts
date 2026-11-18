import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getDb } from "@/lib/db";
import { setMissionPrUrl } from "@deptend/core/db/missions.js";
import { parsePullRequestUrl } from "@deptend/core/pipeline/parse-pr-url.js";
import { checkMissionActionLimit } from "@/lib/rate-limit";
import { gateRequest } from "@/lib/route-gate";

/**
 * POST /api/missions/[id]/pr-link — the current claimant attaches or clears
 * the mission's fix-PR link (ADR 0068). Body: {"prUrl": "https://github.com/
 * owner/repo/pull/N"} to set, {"prUrl": null} to clear. Same mission-action
 * gate stack as claim/unclaim: same-origin → session → shared rate limit →
 * uuid (ADR 0037); the claimant-ownership rule itself lives in core's
 * setMissionPrUrl WHERE clause.
 *
 * Revalidates only the "missions" tag: the link renders on board cards and
 * the permalink page, but the directory's per-repo severity counts don't
 * read it (claim/unclaim revalidate "repos" too because they change those
 * counts — this write doesn't).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gated = await gateRequest({
    request,
    params,
    rateLimiter: checkMissionActionLimit,
    authMessage: "Sign in with GitHub to link a pull request.",
    rateLimitMessage: "Too many mission actions. Try again shortly.",
    invalidIdMessage: "Invalid mission id.",
  });
  if (!gated.ok) {
    return gated.response;
  }
  const { id, login } = gated;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const prUrl =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>).prUrl : undefined;

  if (typeof prUrl !== "string" && prUrl !== null) {
    return NextResponse.json({ error: 'Body must be {"prUrl": string | null}.' }, { status: 400 });
  }

  let normalizedUrl: string | null = null;
  if (prUrl !== null) {
    const parsed = parsePullRequestUrl(prUrl);
    if (parsed === null) {
      return NextResponse.json(
        { error: "Provide a GitHub pull-request URL (https://github.com/owner/repo/pull/N)." },
        { status: 400 },
      );
    }
    normalizedUrl = parsed.url;
  }

  const outcome = await setMissionPrUrl(getDb(), id, normalizedUrl, login);

  if (outcome === "not_found") {
    return NextResponse.json({ error: "Mission not found." }, { status: 404 });
  }

  if (outcome === "not_claimed_by_you") {
    return NextResponse.json(
      { error: "Only the mission's current claimant can set or clear its PR link." },
      { status: 409 },
    );
  }

  revalidateTag("missions");

  return NextResponse.json({
    message: normalizedUrl === null ? "PR link removed." : "PR link saved.",
  });
}
