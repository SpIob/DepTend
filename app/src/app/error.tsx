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
    console.error(error);
  }, [error]);

  return (
    <main id="main" className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-16 sm:px-6 sm:py-24">
      <div className="border-border bg-surface rounded-md border p-8 text-center">
        <h1 className="text-ink font-mono text-lg font-bold">Something went wrong</h1>
        <p className="text-ink-muted mx-auto mt-2 max-w-md text-sm leading-relaxed">
          The page failed to load. This is usually temporary — try again, or head back to the
          mission board.
        </p>
        {error.digest !== undefined && (
          <p
            className="text-ink-muted/70 mt-3 font-mono text-xs"
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
            className="bg-accent rounded-md px-3 py-1.5 font-mono text-xs font-medium text-white hover:opacity-90"
          >
            Try again
          </button>
          <Link
            href="/"
            className="border-border text-ink-muted hover:text-ink hover:border-ink-muted rounded-md border px-3 py-1.5 font-mono text-xs"
          >
            Browse repos
          </Link>
        </div>
      </div>
    </main>
  );
}
