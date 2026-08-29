import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { subscribeToRepo } from "@deptend/core/notifications/subscriptions.js";
import { isValidUuid } from "@deptend/core/db/validation.js";
import { checkMissionActionLimit } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/request-origin";
import { parseOptionalJsonBody } from "@/lib/body-parse";

// M3 (security audit 2026-08-29): allow-list the event types the route
// will persist into notification_subscriptions.event_types. Matches the
// union github-issues.ts already typechecks against (its
// NotificationPayload.type field) so the values reach GitHub issue
// labels verbatim. Anything else - including "XSS attempt disguised as
// an event type" - is rejected at the API boundary with 400, before
// subscribeToRepo() can persist it.
//
// The migration's column default is
//   ARRAY['new_mission', 'claimed', 'resolved']
// (no "reopened") but github-issues.ts lists four. We accept all four;
// a row carrying "reopened" in eventTypes is harmless even if no issue
// is ever created with that label today.
const ALLOWED_EVENT_TYPES = ["new_mission", "claimed", "resolved", "reopened"] as const;
type AllowedEventType = (typeof ALLOWED_EVENT_TYPES)[number];

// M3 cap matches the allow-list's documented size. The route rejects
// anything larger so a malicious client can't grow their row to
// arbitrary size or inject arbitrary GitHub issue labels via
// github-issues.ts's `labels: [type, repo.owner]`.
const MAX_EVENT_TYPES = ALLOWED_EVENT_TYPES.length;

interface SubscribeBody {
  eventTypes?: unknown;
}

function isSubscribeBody(value: unknown): value is SubscribeBody {
  return typeof value === "object" && value !== null;
}

function isAllowedEventTypes(value: unknown): value is AllowedEventType[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0 || value.length > MAX_EVENT_TYPES) return false;
  return value.every(
    (entry): entry is AllowedEventType =>
      typeof entry === "string" && (ALLOWED_EVENT_TYPES as readonly string[]).includes(entry),
  );
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

  let body: unknown = null;
  body = await parseOptionalJsonBody(request);

  let eventTypes: AllowedEventType[] | undefined;
  if (isSubscribeBody(body) && body.eventTypes !== undefined) {
    if (!isAllowedEventTypes(body.eventTypes)) {
      return NextResponse.json(
        {
          error:
            `eventTypes must be a non-empty array (max ${String(MAX_EVENT_TYPES)} items) drawn from: ` +
            ALLOWED_EVENT_TYPES.join(", "),
        },
        { status: 400 },
      );
    }
    eventTypes = body.eventTypes;
  }

  try {
    const db = getDb();
    // subscribeToRepo now returns a discriminated outcome so the route
    // can return 201 on a fresh insert and 200 on an event-types update
    // of an existing row (PR 1, item 1.2).
    const { outcome, subscription } = await subscribeToRepo(db, {
      userLogin: login,
      repoId,
      ...(eventTypes !== undefined && { eventTypes }),
    });

    revalidateTag("repos");

    const message =
      outcome === "subscribed" ? "Subscribed to notifications." : "Subscription updated.";
    const status = outcome === "subscribed" ? 201 : 200;
    return NextResponse.json({ message, subscription }, { status });
  } catch (err) {
    // L2 (security audit 2026-08-29): log message, not the full Error
    // object. Drizzle sometimes populates the error with bound query
    // parameters; a raw console.error(err) would land them in
    // Vercel function logs, which is unnecessary and on the wrong
    // side of the "never log secrets" line. Matches the discipline
    // already in use in app/src/lib/rate-limit.ts.
    console.error("[notifications/subscribe] error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to subscribe to notifications." }, { status: 500 });
  }
}
