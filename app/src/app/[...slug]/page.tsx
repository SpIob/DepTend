import { notFound } from "next/navigation";

/**
 * Catch-all for any URL that doesn't match a real route under `/app/`.
 * Without this, Next.js 15.5 returns a 200 with an empty body for
 * top-level unmatched URLs (e.g. `/totally-bogus`, `/x`, or any
 * mistyped path the user pastes in). The body is the RSC payload only
 * — no `<main>`, no `<h1>`, no visible content — and the browser tab
 * title is empty.
 *
 * `notFound()` triggered from inside a page render (e.g.
 * `app/src/app/repo/[owner]/[name]/page.tsx:63-66` when `getRepoByOwnerAndName`
 * returns null) does correctly render `app/src/app/not-found.tsx`. The
 * only case that was broken is the URL Next itself doesn't recognize
 * as a route at all.
 *
 * Forcing the path through this catch-all before falling through to
 * the boundary makes `/this-fake-page` render the same 404 page as
 * `/repo/this-fake-page/whatever`. One line of behavior, no new
 * components, no new query code.
 */
export default function NotFoundCatchAll(): never {
  notFound();
}
