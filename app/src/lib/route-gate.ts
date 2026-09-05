/**
 * Shared preamble for /app's `[id]`-keyed mutating API routes
 * (claim/unclaim/dismiss/undismiss, bookmark/unbookmark/withdraw,
 * notifications/subscribe/unsubscribe). The four checks live here in one
 * place so a future audit fix lands once, and so the production contract
 * matches the test contract — `route-test-setup.ts`'s `runSharedTests()`
 * was derived from the same gate order (origin → session → rate-limit →
 * UUID), keeping mocks and reality aligned (AGENTS.md §6 meta-lesson).
 *
 * Returns either an early error Response (the same status/message each
 * route used to write inline) or the validated { id, login } pair the
 * caller needs to call its core function.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { isValidUuid } from "@deptend/core/db/validation.js";
import { isSameOrigin } from "@/lib/request-origin";

type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface GateRequestOptions {
  request: Request;
  params: Promise<{ id: string }>;
  /** Per-action limiter, e.g. checkMissionActionLimit or checkRepoSubmissionLimit. */
  rateLimiter: (key: string) => RateLimitResult;
  /** 401 message — different copy per surface (claim, bookmark, withdraw, etc.). */
  authMessage: string;
  /** 429 message — "mission actions" vs "actions" depending on the limiter's scope. */
  rateLimitMessage: string;
  /** 400 message — "mission id" vs "repo id" per route family. */
  invalidIdMessage: string;
}

export type GateRequestResult =
  { ok: true; id: string; login: string } | { ok: false; response: Response };

export async function gateRequest(opts: GateRequestOptions): Promise<GateRequestResult> {
  if (!isSameOrigin(opts.request)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 }),
    };
  }

  const session = await getServerSession(authOptions);
  const login = session?.user?.login;
  if (login === undefined) {
    return { ok: false, response: NextResponse.json({ error: opts.authMessage }, { status: 401 }) };
  }

  const rateLimit = opts.rateLimiter(login);
  if (!rateLimit.allowed) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: opts.rateLimitMessage },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
      ),
    };
  }

  const { id } = await opts.params;
  if (!isValidUuid(id)) {
    return {
      ok: false,
      response: NextResponse.json({ error: opts.invalidIdMessage }, { status: 400 }),
    };
  }

  return { ok: true, id, login };
}
