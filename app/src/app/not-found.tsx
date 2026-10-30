import Link from "next/link";

export default function NotFound(): React.JSX.Element {
  return (
    <main id="main" className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-16 sm:px-6 sm:py-24">
      <div className="rounded-md border border-border bg-surface p-8 text-center">
        <h1 className="font-mono text-lg font-bold text-ink">404 — not found</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
          That page doesn&apos;t exist. It may have been a mistyped repo path, or a mission that has
          since been resolved.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="rounded-md bg-accent px-3 py-1.5 font-mono text-xs font-medium text-white hover:opacity-90"
          >
            Browse repos
          </Link>
          <Link
            href="/missions"
            className="rounded-md border border-border px-3 py-1.5 font-mono text-xs text-ink-muted hover:border-ink-muted hover:text-ink"
          >
            All missions
          </Link>
        </div>
      </div>
    </main>
  );
}
