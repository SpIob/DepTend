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
          <div className="border-border bg-surface rounded-md border p-8 text-center">
            <h1 className="text-ink font-mono text-lg font-bold">Something went wrong</h1>
            <p className="text-ink-muted mx-auto mt-2 max-w-md text-sm leading-relaxed">
              The application failed to start. A reload usually fixes this.
            </p>
            {error.digest !== undefined && (
              <p
                className="text-ink-muted/70 mt-3 font-mono text-xs"
                title="Include this if you report an issue"
              >
                ref: {error.digest}
              </p>
            )}
            <button
              type="button"
              onClick={reset}
              className="bg-accent mt-6 rounded-md px-3 py-1.5 font-mono text-xs font-medium text-white hover:opacity-90"
            >
              Reload
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
