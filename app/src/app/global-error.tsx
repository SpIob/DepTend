"use client";

/**
 * Global error boundary — last resort when even the root layout throws.
 * Unlike error.tsx it must render its own <html>/<body> shell, and it
 * cannot reset in place (nothing above it survived), so the only recovery
 * offered is a full reload.
 */
export default function GlobalErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <html lang="en">
      <body>
        <main
          id="main"
          className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-16 sm:px-6 sm:py-24"
        >
          <div className="rounded-md border border-border bg-surface p-8 text-center">
            <h1 className="font-mono text-lg font-bold text-ink">Something went wrong</h1>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
              The application failed to start. A reload usually fixes this.
            </p>
            {error.digest !== undefined && (
              <p
                className="mt-3 font-mono text-xs text-ink-muted/70"
                title="Include this if you report an issue"
              >
                ref: {error.digest}
              </p>
            )}
            <button
              type="button"
              onClick={reset}
              className="mt-6 rounded-md bg-accent px-3 py-1.5 font-mono text-xs font-medium text-white hover:opacity-90"
            >
              Reload
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
