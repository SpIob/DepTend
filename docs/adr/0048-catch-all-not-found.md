# ADR 0048; Render the not-found boundary for top-level unmatched routes

**Status:** Accepted
**Date:** 2026-08-30

---

## Context

A UI audit on 2026-08-30 surfaced Finding B2: any URL that doesn't match a real route under `app/src/app/` returns HTTP 404 with a body that contains only the RSC payload — `<script>` tags carrying the not-found-tree's RSC, but no rendered `<main>`, no `<h1>`, no visible content. The browser tab title is empty. The page looks like a blank screen with the URL bar showing the user's mistyped path.

Reproduced against `deptend.vercel.app` with `/totally-not-a-real-page`, `/x`, `/this-fake-page`, `/some-bogus-path`, `/another-bogus-path`. All five returned the same broken blank state. Same behavior locally against `next dev`.

The contrast: `notFound()` triggered from inside a real page render does correctly show the existing `app/src/app/not-found.tsx` boundary. Tested with `/org/SpIob` (where `getOrganizationByLogin` returns null at `app/src/app/org/[org]/page.tsx:42-43`) and `/repo/SpIob/this-does-not-exist-12345` (where `getRepoByOwnerAndName` returns null at `app/src/app/repo/[owner]/[name]/page.tsx:63-66`). Both rendered the styled 404 page with "Browse repos" and "All missions" CTAs.

The difference: the first case is a real route that the user reached, where the page component called `notFound()`. The second case is a URL that Next's router doesn't recognize as a route at all, and Next 15.5's behavior for that case is to return the 404 status with an RSC payload that the client never hydrates into visible DOM. The `not-found.tsx` file at the app root exists; it just doesn't run in this case.

## Decision

Add a top-level catch-all `app/src/app/[...slug]/page.tsx` that calls `notFound()`. The catch-all is matched by Next's router for any URL that doesn't match a more specific route, so the not-found boundary runs for every mistyped path the same way it does for an `notFound()`-throwing page.

```ts
// app/src/app/[...slug]/page.tsx
import { notFound } from "next/navigation";

export default function NotFoundCatchAll(): never {
  notFound();
}
```

No new components, no new query code, no schema change. The existing `app/src/app/not-found.tsx` is the source of truth for the page content; this catch-all just routes URLs into it.

### Why a catch-all, not a different Next.js config

Next 15.5's behavior for unmatched top-level routes is to serve a 404 with the RSC payload only, and the client doesn't hydrate the not-found boundary. There is no Next config option that flips this — the file-based router's behavior is "no matching file, return 404 with empty body". The only fixes are:

1. **Add a catch-all `[...slug]/page.tsx`** that calls `notFound()`. This forces the boundary to render. Minimal, idiomatic, matches the rest of the app.
2. **Replace the global `not-found.tsx` with a different rendering strategy** (e.g. a custom error boundary that doesn't rely on Next's `_not-found` route). Larger surface area, harder to keep aligned with the rest of the routing tree.

Option 1 is what AGENTS.md §0 means by "a settled decision" — small, in the same idiom as `app/src/app/repo/[owner]/[name]/page.tsx:65` and `app/src/app/org/[org]/page.tsx:42` already do.

### Why not gate this on a list of known URL prefixes

Tempting alternative: `app/src/app/[...slug]/page.tsx` that checks if the slug starts with `/repo/`, `/org/`, `/missions`, etc., and only calls `notFound()` for unrecognized prefixes. Rejected because:

- The real routes already match first (Next's router walks specific-to-generic). The catch-all is only reached when no other route matched. There's nothing to gate.
- Maintaining a "known prefixes" list in two places (router + this file) is a footgun: a typo or rename in one place would silently break the gate, and the failure mode is exactly the bug we're fixing.

## Implementation

### `app/src/app/[...slug]/page.tsx`

One file, two lines of executable code (the function body is just `notFound()`). JSDoc explains why this file exists and references the two existing `notFound()` call sites so the rationale travels with the code.

### What didn't change

- `app/src/app/not-found.tsx` — the 404 page itself is unchanged.
- `app/src/app/repo/[owner]/[name]/page.tsx:63-66` and `app/src/app/org/[org]/page.tsx:42-43` — both still call `notFound()` directly. The catch-all is additive, not a replacement.
- No query, schema, or dependency change. Pure routing fix.

## Consequences

**Positive.**

- Every mistyped URL on `deptend.vercel.app` now renders the same styled 404 page with a working "Browse repos" / "All missions" CTA, instead of a blank screen with an empty tab title.
- The fix is one file. The blast radius is limited to URLs Next doesn't recognize, which is precisely the broken set.
- No new dep, no new query, no schema migration. Zero impact on the production runtime cost.

**Negative.**

- A catch-all `[...slug]/page.tsx` means Next will run `notFound()` for every URL that doesn't match a real route. The cost is one render that throws — negligible, and arguably better than the current 200-with-empty-body behavior because the response is now consistent.
- The `notFound()` call in the catch-all always sets the response status to 404. That's the correct behavior for unmatched routes, but worth noting that this is a "real" 404, not a 200 with an empty body. (Search engines and uptime monitors will see 404s, which is what they should.)

**Open question / future work.**

- If the app grows more routes (e.g. a future `/repos`, `/about`, `/login`), the catch-all continues to work — those real routes match first. No change needed.
- A future analytics pass might want to log the matched `[...slug]` values to see what users are typing. Not in scope here; trivial to add later by reading `params.slug` inside the catch-all.
