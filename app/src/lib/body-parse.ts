/**
 * Shared body-parsing helper for the mutating API routes.
 *
 * The project-wide convention (per AGENTS.md §0.1's "verify against real
 * code" rule) is: an optional body silently degrades to "no body"; a
 * present-but-malformed body is a 400. Both policies used to live inline
 * in each route, with three different error-handling shapes for the same
 * failure mode (findings 4.1 and 4.2 in the data-handling survey). The
 * helper unifies them so the body policy lives in one place and routes
 * document their own choice with a single word.
 *
 * Two return shapes:
 *   - `parseOptionalJsonBody(request)` — returns `null` on missing OR
 *     malformed body. Caller treats both as "no body, fall through to
 *     defaults." This is the right shape for routes where the body is
 *     genuinely optional (subscribe's eventTypes, dismiss's reason).
 *   - `parseRequiredJsonBody(request)` — returns the parsed value, or
 *     throws `BadJsonError` on malformed input. Caller catches and
 *     returns 400. This is the right shape for routes where the body
 *     carries the whole point of the request (submit's githubUrl).
 */

/** Thrown by parseRequiredJsonBody when the body is present but not
 *  valid JSON. Routes catch this to return 400. */
export class BadJsonError extends Error {
  constructor(message = "Invalid JSON body.") {
    super(message);
    this.name = "BadJsonError";
  }
}

/** Returns `null` for an absent or malformed body. Returns the parsed
 *  value (object or otherwise) for a valid JSON body. */
export async function parseOptionalJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Returns the parsed value for a valid JSON body. Throws BadJsonError
 *  on a malformed body so the caller can return 400. Returns `null` for
 *  a missing body (the caller can decide whether that's a 400 or a
 *  fallthrough). */
export async function parseRequiredJsonBody(request: Request): Promise<unknown> {
  // A literal "no body" is distinguishable from "malformed body" by
  // checking Content-Length / a real read. undici's Request.text() on
  // a bodyless request returns "" — JSON.parse("") throws, so we
  // special-case empty input.
  const text = await request.text();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadJsonError();
  }
}
