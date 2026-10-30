"use client";

interface PaginationProps {
  page: number;
  pageCount: number;
  isPending: boolean;
  navigate: (href: string) => void;
  buildHref: (overrides: { page: number }) => string;
}

export function Pagination({
  page,
  pageCount,
  isPending,
  navigate,
  buildHref,
}: PaginationProps): React.ReactElement | null {
  if (pageCount <= 1) return null;

  return (
    <nav aria-label="Mission pages" className="flex items-center justify-between pt-2">
      {page > 1 ? (
        <button
          type="button"
          onClick={() => {
            navigate(buildHref({ page: page - 1 }));
          }}
          disabled={isPending}
          className="rounded-md border border-border px-3 py-1.5 font-mono text-xs text-ink-muted hover:border-ink-muted hover:text-ink disabled:opacity-50"
        >
          ← Previous
        </button>
      ) : (
        <span className="rounded-md border border-border px-3 py-1.5 font-mono text-xs text-ink-muted/50">
          ← Previous
        </span>
      )}
      <span className="font-mono text-xs text-ink-muted">
        Page {page.toString()} of {pageCount.toString()}
      </span>
      {page < pageCount ? (
        <button
          type="button"
          onClick={() => {
            navigate(buildHref({ page: page + 1 }));
          }}
          disabled={isPending}
          className="rounded-md border border-border px-3 py-1.5 font-mono text-xs text-ink-muted hover:border-ink-muted hover:text-ink disabled:opacity-50"
        >
          Next →
        </button>
      ) : (
        <span className="rounded-md border border-border px-3 py-1.5 font-mono text-xs text-ink-muted/50">
          Next →
        </span>
      )}
    </nav>
  );
}
