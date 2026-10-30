"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Route-segment error boundary. Next renders this whenever a server
 * component throws during render/data fetch (e.g. Neon unreachable) —
 * previously such a throw fell through to Next's default unstyled error
 * screen. The error itself is logged client-side but never rendered:
 * messages from server internals aren't user-facing content. The
 * optional digest is Next's correlation id for matching the throw to
 * server logs.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  useEffect(() => {
    // L2 (security audit 2026-08-29): log message, not the full Error
    // object. Drizzle and the React server boundary sometimes populate
    // thrown errors with request context (URL, headers, stack) that
    // can echo user-controlled values into Vercel function logs.
    // Matches the discipline in app/src/lib/rate-limit.ts and the
    // two notifications routes - "log the line, not the stack."
    console.error(error instanceof Error ? error.message : error);
  }, [error]);

  return (
    <main id="main" className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-16 sm:px-6 sm:py-24">
      <div className="rounded-md border border-border bg-surface p-8 text-center">
        <h1 className="font-mono text-lg font-bold text-ink">Something went wrong</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
          The page failed to load. This is usually temporary — try again, or head back to the
          mission board.
        </p>
        {error.digest !== undefined && (
          <p
            className="mt-3 font-mono text-xs text-ink-muted/70"
            // Tooltip on the digest so users pasting it into a report
            // remember to include it. The role="status" announcement that
            // reads "ref: <digest>" out loud can't explain its purpose
            // without being annoying.
            title="Include this if you report an issue"
          >
            ref: {error.digest}
          </p>
        )}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-md bg-accent px-3 py-1.5 font-mono text-xs font-medium text-white hover:opacity-90"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-md border border-border px-3 py-1.5 font-mono text-xs text-ink-muted hover:border-ink-muted hover:text-ink"
          >
            Browse repos
          </Link>
        </div>
      </div>
    </main>
  );
}
